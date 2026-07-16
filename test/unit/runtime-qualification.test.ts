import { describe, expect, it, vi } from 'vitest';

import {
  MAX_RUNTIME_OPERATION_QUALIFIERS,
  MAX_RUNTIME_QUALIFICATION_CREDENTIAL_BYTES,
  qualifyRuntimeOperations,
  RuntimeQualificationError,
} from '../../src/application/runtime-qualification.js';
import {
  sealRuntimeBindings,
  type RuntimeBindings,
} from '../../src/domain/runtime-bindings.js';
import {
  computeRuntimeQualificationProfileDigest,
  RUNTIME_QUALIFICATION_PRODUCER,
  RUNTIME_QUALIFICATION_SCOPE,
  runtimeQualificationProfileSchema,
  sealRuntimeQualificationReport,
  verifyRuntimeQualificationReportDigest,
  type RuntimeQualificationProfile,
} from '../../src/domain/runtime-qualification.js';
import type { RuntimeOperationQualifier } from '../../src/ports/runtime-operation-qualifier.js';

const SECRET = 'sk-qualification-secret-sentinel';

function bindings(targetCount = 2): RuntimeBindings {
  return sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 1_000,
      maxResponseBytes: 16_384,
      snapshotTtlSeconds: 60,
    },
    targets: Array.from({ length: targetCount }, (_, index) => ({
      targetId: `target-${index}`,
      provider: {
        kind: 'openai-compatible' as const,
        name: `provider-${index}`,
        baseUrl: `https://provider-${index}.invalid/v1`,
        ...(index === 0 ? { apiKeyEnv: 'STAGEFABRIC_QUALIFICATION_KEY' } : {}),
      },
      operations: [
        {
          kind: 'generate-text' as const,
          operation: 'generate',
          capabilities: ['text-generation'],
          model: `model-${index}`,
          input: 'prompt',
          output: 'text',
          maxOutputTokens: 64,
        },
        {
          kind: 'embedding' as const,
          operation: 'embed',
          capabilities: ['embedding'],
          model: `embedding-${index}`,
          input: 'text',
          output: 'vector',
          expectedDimensions: 3,
        },
      ],
    })),
  });
}

function profile(
  targetCount = 2,
  overrides: Partial<RuntimeQualificationProfile['limits']> = {},
): RuntimeQualificationProfile {
  return runtimeQualificationProfileSchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeQualificationProfile',
    limits: {
      totalTimeoutMs: overrides.totalTimeoutMs ?? 2_000,
      maxConcurrency: overrides.maxConcurrency ?? 2,
      maxTargets: overrides.maxTargets ?? targetCount,
      maxOperations: overrides.maxOperations ?? targetCount * 2,
      maxGenerationOutputTokensPerCall:
        overrides.maxGenerationOutputTokensPerCall ?? 256,
    },
    targets: Array.from({ length: targetCount }, (_, index) => ({
      targetId: `target-${targetCount - index - 1}`,
      operations: ['generate', 'embed'],
    })),
  });
}

function passingQualifier(
  implementation?: RuntimeOperationQualifier['qualify'],
): RuntimeOperationQualifier {
  return {
    kind: 'openai-compatible',
    version: 'test-v1',
    qualify:
      implementation ??
      (async ({ operations }) =>
        operations.map((operation) => ({
          operation: operation.operation,
          operationKind: operation.kind,
          status: 'qualified' as const,
          reasonCode: 'qualified' as const,
        }))),
  };
}

describe('RuntimeQualification contracts', () => {
  it('canonicalizes explicit selections and rejects executable or prompt config', () => {
    const original = profile();
    const reordered = {
      ...original,
      targets: [...original.targets].reverse().map((target) => ({
        ...target,
        operations: [...target.operations].reverse(),
      })),
    };
    expect(computeRuntimeQualificationProfileDigest(reordered)).toBe(
      computeRuntimeQualificationProfileDigest(original),
    );
    expect(
      computeRuntimeQualificationProfileDigest({
        ...original,
        limits: {
          ...original.limits,
          maxGenerationOutputTokensPerCall:
            original.limits.maxGenerationOutputTokensPerCall - 1,
        },
      }),
    ).not.toBe(computeRuntimeQualificationProfileDigest(original));

    expect(
      runtimeQualificationProfileSchema.safeParse({
        ...original,
        prompt: SECRET,
      }).success,
    ).toBe(false);
    expect(
      runtimeQualificationProfileSchema.safeParse({
        ...original,
        module: './qualifier.js',
      }).success,
    ).toBe(false);
  });

  it('seals only content-free report fields and detects mutation', () => {
    const sealed = sealRuntimeQualificationReport({
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'RuntimeQualificationReport',
      bindingDigest: `sha256:${'1'.repeat(64)}`,
      profileDigest: `sha256:${'2'.repeat(64)}`,
      qualificationScope: RUNTIME_QUALIFICATION_SCOPE,
      producer: { ...RUNTIME_QUALIFICATION_PRODUCER },
      qualified: true,
      results: [
        {
          targetId: 'target-0',
          operation: 'generate',
          operationKind: 'generate-text',
          status: 'qualified',
          reasonCode: 'qualified',
          qualifier: { kind: 'openai-compatible', version: 'test-v1' },
        },
      ],
    });
    expect(verifyRuntimeQualificationReportDigest(sealed)).toBe(true);
    expect(
      verifyRuntimeQualificationReportDigest({
        ...sealed,
        profileDigest: `sha256:${'3'.repeat(64)}`,
      }),
    ).toBe(false);
    const versionChanged = sealRuntimeQualificationReport({
      ...Object.fromEntries(
        Object.entries(sealed).filter(([key]) => key !== 'digest'),
      ),
      results: sealed.results.map((result) => ({
        ...result,
        qualifier: { kind: 'openai-compatible', version: 'test-v2' },
      })),
    });
    expect(versionChanged.digest).not.toBe(sealed.digest);
    for (const forbidden of [
      'endpoint',
      'model',
      'credential',
      'prompt',
      'output',
      'error',
      'observedAt',
      'timestamp',
    ]) {
      expect(JSON.stringify(sealed)).not.toContain(forbidden);
    }

    const content = Object.fromEntries(
      Object.entries(sealed).filter(([key]) => key !== 'digest'),
    );
    expect(() =>
      sealRuntimeQualificationReport({
        ...content,
        results: [sealed.results[0], sealed.results[0]],
      }),
    ).toThrow();
  });
});

describe('runtime qualification orchestrator', () => {
  it('enforces target concurrency and emits deterministic sorted evidence', async () => {
    let active = 0;
    let maximumActive = 0;
    const qualifier = passingQualifier(async ({ operations }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return [...operations].reverse().map((operation) => ({
        operation: operation.operation,
        operationKind: operation.kind,
        status: 'qualified' as const,
        reasonCode: 'qualified' as const,
      }));
    });

    const report = await qualifyRuntimeOperations(
      { bindings: bindings(3), profile: profile(3) },
      { qualifiers: [qualifier], resolveCredential: () => SECRET },
    );

    expect(maximumActive).toBe(2);
    expect(report.qualified).toBe(true);
    expect(report.qualificationScope).toBe(RUNTIME_QUALIFICATION_SCOPE);
    expect(report.producer).toEqual(RUNTIME_QUALIFICATION_PRODUCER);
    expect(
      report.results.every(
        (result) =>
          result.qualifier?.kind === 'openai-compatible' &&
          result.qualifier.version === 'test-v1',
      ),
    ).toBe(true);
    expect(
      report.results.map(({ targetId, operation }) => [targetId, operation]),
    ).toEqual([
      ['target-0', 'embed'],
      ['target-0', 'generate'],
      ['target-1', 'embed'],
      ['target-1', 'generate'],
      ['target-2', 'embed'],
      ['target-2', 'generate'],
    ]);
    expect(verifyRuntimeQualificationReportDigest(report)).toBe(true);
  });

  it('passes a resolved credential without ever returning it', async () => {
    const qualify = vi.fn<RuntimeOperationQualifier['qualify']>(
      async ({ credential, operations }) => {
        expect(credential).toBe(SECRET);
        return operations.map((operation) => ({
          operation: operation.operation,
          operationKind: operation.kind,
          status: 'qualified' as const,
          reasonCode: 'qualified' as const,
        }));
      },
    );
    const report = await qualifyRuntimeOperations(
      { bindings: bindings(1), profile: profile(1) },
      {
        qualifiers: [passingQualifier(qualify)],
        resolveCredential: ({ reference }) => {
          expect(reference).toBe('STAGEFABRIC_QUALIFICATION_KEY');
          return SECRET;
        },
      },
    );
    expect(qualify).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain('provider-0.invalid');
    expect(JSON.stringify(report)).not.toContain('model-0');
  });

  it('keeps evidence private and exposes only a recursively frozen qualifier snapshot', async () => {
    const qualify = vi.fn<RuntimeOperationQualifier['qualify']>(
      async ({ target, operations }) => {
        expect(Object.isFrozen(target)).toBe(true);
        expect(Object.isFrozen(target.provider)).toBe(true);
        expect(Object.isFrozen(target.operations)).toBe(true);
        expect(Object.isFrozen(operations)).toBe(true);
        expect(operations.every(Object.isFrozen)).toBe(true);
        expect(Reflect.set(target, 'targetId', 'forged-target')).toBe(false);
        expect(
          Reflect.set(operations[0]!, 'operation', 'forged-operation'),
        ).toBe(false);
        return operations.map((operation) => ({
          operation: operation.operation,
          operationKind: operation.kind,
          status: 'qualified' as const,
          reasonCode: 'qualified' as const,
        }));
      },
    );

    const report = await qualifyRuntimeOperations(
      { bindings: bindings(1), profile: profile(1) },
      {
        qualifiers: [passingQualifier(qualify)],
        resolveCredential: () => SECRET,
      },
    );

    expect(report.qualified).toBe(true);
    expect(
      report.results.map(({ targetId, operation }) => [targetId, operation]),
    ).toEqual([
      ['target-0', 'embed'],
      ['target-0', 'generate'],
    ]);
    expect(JSON.stringify(report)).not.toContain('forged');
  });

  it.each([undefined, 257] as const)(
    'rejects generation max %s before credential resolution or qualifier I/O',
    async (maxOutputTokens) => {
      const original = bindings(1);
      const { digest: _digest, ...content } = original;
      const changed = structuredClone(content);
      const generation = changed.targets[0]?.operations.find(
        (operation) => operation.kind === 'generate-text',
      );
      if (generation === undefined || generation.kind !== 'generate-text') {
        throw new Error('expected_generation_binding');
      }
      if (maxOutputTokens === undefined) {
        delete generation.maxOutputTokens;
      } else {
        generation.maxOutputTokens = maxOutputTokens;
      }
      const sealed = sealRuntimeBindings(changed);
      const qualify = vi.fn(passingQualifier().qualify);
      const resolveCredential = vi.fn(() => SECRET);
      const selectedProfile = {
        ...profile(1, { maxGenerationOutputTokensPerCall: 256 }),
        limits: {
          ...profile(1).limits,
          maxOperations: 1,
          maxGenerationOutputTokensPerCall: 256,
        },
        targets: [{ targetId: 'target-0', operations: ['generate'] }],
      };

      const report = await qualifyRuntimeOperations(
        { bindings: sealed, profile: selectedProfile },
        { qualifiers: [passingQualifier(qualify)], resolveCredential },
      );

      expect(qualify).not.toHaveBeenCalled();
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(report.qualified).toBe(false);
      expect(report.results).toEqual([
        expect.objectContaining({
          targetId: 'target-0',
          operation: 'generate',
          reasonCode: 'operation_configuration_unqualified',
        }),
      ]);
    },
  );

  it.each([
    ['missing resolver', undefined],
    [
      'throwing resolver',
      (): never => {
        throw new Error(`resolver-${SECRET}`);
      },
    ],
    ['undefined credential', (): undefined => undefined],
    ['empty credential', (): string => ''],
    ['whitespace credential', (): string => '   '],
    ['CRLF credential', (): string => `${SECRET}\r\nforged: true`],
    [
      'oversized credential',
      (): string => 'x'.repeat(MAX_RUNTIME_QUALIFICATION_CREDENTIAL_BYTES + 1),
    ],
    [
      'oversized UTF-8 credential',
      (): string =>
        '€'.repeat(
          Math.floor(MAX_RUNTIME_QUALIFICATION_CREDENTIAL_BYTES / 3) + 1,
        ),
    ],
  ] as const)(
    'rejects %s before invoking even a permissive qualifier',
    async (_label, resolveCredential) => {
      const qualify = vi.fn(passingQualifier().qualify);
      const report = await qualifyRuntimeOperations(
        { bindings: bindings(1), profile: profile(1) },
        {
          qualifiers: [passingQualifier(qualify)],
          ...(resolveCredential === undefined ? {} : { resolveCredential }),
        },
      );

      expect(qualify).not.toHaveBeenCalled();
      expect(report.qualified).toBe(false);
      expect(
        report.results.every(
          (result) =>
            result.reasonCode === 'credential_unavailable' &&
            result.qualifier?.version === 'test-v1',
        ),
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain(SECRET);
    },
  );

  it('fails closed for unavailable and malformed qualifiers', async () => {
    const unavailable = await qualifyRuntimeOperations(
      { bindings: bindings(1), profile: profile(1) },
      { qualifiers: [] },
    );
    expect(unavailable.qualified).toBe(false);
    expect(
      unavailable.results.every(
        (result) =>
          result.reasonCode === 'qualifier_unavailable' &&
          result.qualifier === null,
      ),
    ).toBe(true);

    const malformed = await qualifyRuntimeOperations(
      { bindings: bindings(1), profile: profile(1) },
      {
        qualifiers: [
          passingQualifier(async () => [
            {
              operation: `generate-${SECRET}`,
              operationKind: 'generate-text',
              status: 'rejected',
              reasonCode: 'operation_rejected',
            },
          ]),
        ],
        resolveCredential: () => SECRET,
      },
    );
    expect(
      malformed.results.every(
        (result) => result.reasonCode === 'qualifier_failure',
      ),
    ).toBe(true);
    expect(JSON.stringify(malformed)).not.toContain(SECRET);

    const spoofed = await qualifyRuntimeOperations(
      { bindings: bindings(1), profile: profile(1) },
      {
        qualifiers: [
          passingQualifier(async ({ operations }) =>
            operations.map((operation) => ({
              operation: operation.operation,
              operationKind: operation.kind,
              status: 'qualified' as const,
              reasonCode: 'qualified' as const,
              qualifier: { kind: 'spoofed', version: '999' },
            })),
          ),
        ],
        resolveCredential: () => SECRET,
      },
    );
    expect(spoofed.results).toEqual(
      spoofed.results.map((result) => ({
        ...result,
        status: 'rejected',
        reasonCode: 'qualifier_failure',
        qualifier: { kind: 'openai-compatible', version: 'test-v1' },
      })),
    );
  });

  it('bounds a non-settling qualifier with the total deadline', async () => {
    const report = await qualifyRuntimeOperations(
      {
        bindings: bindings(1),
        profile: profile(1, { totalTimeoutMs: 100 }),
      },
      {
        qualifiers: [
          passingQualifier(
            async () =>
              new Promise<never>(() => {
                // The orchestrator must not depend on an adapter settling.
              }),
          ),
        ],
        resolveCredential: () => SECRET,
      },
    );
    expect(report.qualified).toBe(false);
    expect(
      report.results.every(
        (result) => result.reasonCode === 'deadline_exceeded',
      ),
    ).toBe(true);
  });

  it('forwards the total signal so a cooperative credential resolver stops underlying work', async () => {
    let resolverAborted = false;
    let resolverCompleted = false;
    const qualify = vi.fn(passingQualifier().qualify);
    const report = await qualifyRuntimeOperations(
      {
        bindings: bindings(1),
        profile: profile(1, { totalTimeoutMs: 100 }),
      },
      {
        qualifiers: [passingQualifier(qualify)],
        resolveCredential: ({ signal }) =>
          new Promise<string | undefined>((resolve) => {
            const timer = setTimeout(() => {
              resolverCompleted = true;
              resolve(SECRET);
            }, 500);
            signal.addEventListener(
              'abort',
              () => {
                resolverAborted = true;
                clearTimeout(timer);
                resolve(undefined);
              },
              { once: true },
            );
          }),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolverAborted).toBe(true);
    expect(resolverCompleted).toBe(false);
    expect(qualify).not.toHaveBeenCalled();
    expect(
      report.results.every(
        (result) => result.reasonCode === 'deadline_exceeded',
      ),
    ).toBe(true);
  });

  it('rejects unknown selections, exceeded budgets, and duplicate registries before I/O', async () => {
    const qualify = vi.fn(passingQualifier().qualify);
    await expect(
      qualifyRuntimeOperations(
        {
          bindings: bindings(1),
          profile: {
            ...profile(1),
            targets: [{ targetId: 'unknown', operations: ['generate'] }],
          },
        },
        { qualifiers: [passingQualifier(qualify)] },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeQualificationError>>({
        code: 'selection_invalid',
      }),
    );

    await expect(
      qualifyRuntimeOperations(
        {
          bindings: bindings(1),
          profile: profile(1, { maxOperations: 1 }),
        },
        { qualifiers: [passingQualifier(qualify)] },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeQualificationError>>({
        code: 'qualification_budget_exceeded',
      }),
    );

    await expect(
      qualifyRuntimeOperations(
        { bindings: bindings(1), profile: profile(1) },
        { qualifiers: [passingQualifier(qualify), passingQualifier(qualify)] },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeQualificationError>>({
        code: 'qualifier_registry_invalid',
      }),
    );
    expect(qualify).not.toHaveBeenCalled();
  });

  it.each([
    [
      'unsafe version',
      () => ({ ...passingQualifier(), version: 'unsafe version' }),
    ],
    [
      'throwing getter',
      () =>
        Object.defineProperty(passingQualifier(), 'version', {
          get: () => {
            throw new Error(`registry-${SECRET}`);
          },
        }),
    ],
    [
      'revoked proxy',
      () => {
        const revocable = Proxy.revocable([passingQualifier()], {});
        revocable.revoke();
        return revocable.proxy;
      },
    ],
    [
      'oversized registry',
      () =>
        Array.from(
          { length: MAX_RUNTIME_OPERATION_QUALIFIERS + 1 },
          (_, index) => ({
            ...passingQualifier(),
            kind: `qualifier-${index}`,
          }),
        ),
    ],
  ] as const)(
    'normalizes %s registry failures to a content-free error',
    async (_label, registryFactory) => {
      let caught: unknown;
      try {
        const registry = registryFactory();
        await qualifyRuntimeOperations(
          { bindings: bindings(1), profile: profile(1) },
          {
            qualifiers: registry as readonly RuntimeOperationQualifier[],
            resolveCredential: () => SECRET,
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(
        expect.objectContaining<Partial<RuntimeQualificationError>>({
          code: 'qualifier_registry_invalid',
        }),
      );
      expect(JSON.stringify(caught)).not.toContain(SECRET);
    },
  );

  it('rejects a tampered binding digest before qualifier or credential resolution', async () => {
    const tampered = bindings(1);
    tampered.policy.requestTimeoutMs = 2_000;
    const qualify = vi.fn(passingQualifier().qualify);
    const resolveCredential = vi.fn(() => SECRET);
    await expect(
      qualifyRuntimeOperations(
        { bindings: tampered, profile: profile(1) },
        { qualifiers: [passingQualifier(qualify)], resolveCredential },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeQualificationError>>({
        code: 'binding_digest_mismatch',
      }),
    );
    expect(qualify).not.toHaveBeenCalled();
    expect(resolveCredential).not.toHaveBeenCalled();
  });
});

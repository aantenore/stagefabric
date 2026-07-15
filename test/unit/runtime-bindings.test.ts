import { describe, expect, it } from 'vitest';

import {
  computeRuntimeBindingsDigest,
  RUNTIME_BINDINGS_LIMITS,
  runtimeBindingsContentSchema,
  sealRuntimeBindings,
  verifyRuntimeBindingsDigest,
  type RuntimeBindingsContent,
} from '../../src/domain/runtime-bindings.js';

function content(): RuntimeBindingsContent {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 5_000,
      maxResponseBytes: 64_000,
      snapshotTtlSeconds: 60,
    },
    targets: [
      {
        targetId: 'edge-a',
        provider: {
          kind: 'openai-compatible',
          name: 'edge-vllm',
          baseUrl: 'http://127.0.0.1:8000/v1',
          apiKeyEnv: 'STAGEFABRIC_EDGE_API_KEY',
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'summarize',
            capabilities: ['text-generation', 'summarization'],
            model: 'acme/model-7b',
            input: 'prompt',
            output: 'summary',
            systemPrompt: 'Summarize without adding facts.',
            temperature: 0,
            maxOutputTokens: 512,
          },
          {
            kind: 'embedding',
            operation: 'embed',
            capabilities: ['embedding'],
            model: 'acme/embed-v2',
            input: 'text',
            output: 'vector',
            expectedDimensions: 768,
          },
        ],
      },
    ],
  };
}

describe('RuntimeBindings', () => {
  it('canonicalizes base URLs and seals order-independent content', () => {
    const original = content();
    original.targets[0]!.provider.baseUrl = 'http://LOCALHOST:8000/v1///';
    const sealed = sealRuntimeBindings(original);
    expect(sealed.targets[0]!.provider.baseUrl).toBe(
      'http://localhost:8000/v1',
    );
    expect(verifyRuntimeBindingsDigest(sealed)).toBe(true);

    const reordered = content();
    reordered.targets[0]!.provider.baseUrl = 'http://localhost:8000/v1';
    reordered.targets[0]!.operations.reverse();
    reordered.targets[0]!.operations[1]!.capabilities.reverse();
    expect(computeRuntimeBindingsDigest(reordered)).toBe(sealed.digest);

    const changedDimensions = content();
    const embedding = changedDimensions.targets[0]!.operations[1]!;
    if (embedding.kind !== 'embedding') throw new Error('fixture_invalid');
    embedding.expectedDimensions += 1;
    expect(computeRuntimeBindingsDigest(changedDimensions)).not.toBe(
      sealed.digest,
    );

    const tampered = structuredClone(sealed);
    tampered.policy.snapshotTtlSeconds += 1;
    expect(verifyRuntimeBindingsDigest(tampered)).toBe(false);
  });

  it('rejects duplicate targets, operations and capabilities', () => {
    const duplicateTarget = content();
    duplicateTarget.targets.push(structuredClone(duplicateTarget.targets[0]!));
    expect(
      runtimeBindingsContentSchema.safeParse(duplicateTarget).success,
    ).toBe(false);

    const duplicateOperation = content();
    duplicateOperation.targets[0]!.operations[1]!.operation = 'summarize';
    expect(
      runtimeBindingsContentSchema.safeParse(duplicateOperation).success,
    ).toBe(false);

    const duplicateCapability = content();
    duplicateCapability.targets[0]!.operations[0]!.capabilities = [
      'summarization',
      'summarization',
    ];
    expect(
      runtimeBindingsContentSchema.safeParse(duplicateCapability).success,
    ).toBe(false);
  });

  it.each([
    'http://169.254.169.254/latest',
    'http://10.0.0.1/v1',
    'http://localhost.example/v1',
    'ftp://localhost/v1',
    'https://user:password@example.test/v1',
    'https://example.test/v1?token=secret',
    'https://example.test/v1#fragment',
    'https://example.test/v1/../admin',
    'https://example.test/v1/%2e%2e/admin',
    'https://example.test/v1%2fadmin',
    'https://example.test/v1%5cadmin',
    'https://example.test/v1\\admin',
  ])('rejects unsafe base URL %s', (baseUrl) => {
    const candidate = content();
    candidate.targets[0]!.provider.baseUrl = baseUrl;
    expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
      false,
    );
  });

  it.each([
    'http://localhost:8000/v1',
    'http://127.0.0.2:8000/v1',
    'http://[::1]:8000/v1',
    'https://inference.example.test/v1',
  ])('accepts an HTTPS or loopback base URL %s', (baseUrl) => {
    const candidate = content();
    candidate.targets[0]!.provider.baseUrl = baseUrl;
    expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
      true,
    );
  });

  it('rejects inline secrets, arbitrary headers and executable extensions', () => {
    const base = content();
    const provider = base.targets[0]!.provider;
    for (const extra of [
      { apiKey: 'raw-secret' },
      { headers: { authorization: 'raw-secret' } },
    ]) {
      const candidate = structuredClone(base) as unknown as Record<
        string,
        unknown
      >;
      const target = (candidate['targets'] as Record<string, unknown>[])[0]!;
      target['provider'] = { ...provider, ...extra };
      expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
        false,
      );
    }

    for (const extra of [
      { module: './provider.js' },
      { script: 'process.exit()' },
      { template: '{{ unsafe }}' },
    ]) {
      const candidate = structuredClone(base) as unknown as Record<
        string,
        unknown
      >;
      const target = (candidate['targets'] as Record<string, unknown>[])[0]!;
      const operations = target['operations'] as Record<string, unknown>[];
      operations[0] = { ...operations[0], ...extra };
      expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });

  it('reserves operation evidence and credential names for StageFabric', () => {
    const reserved = content();
    reserved.targets[0]!.operations[0]!.capabilities = [
      'stagefabric.operation/summarize',
    ];
    expect(runtimeBindingsContentSchema.safeParse(reserved).success).toBe(
      false,
    );

    const broadEnvironment = content();
    broadEnvironment.targets[0]!.provider.apiKeyEnv = 'AWS_SECRET_ACCESS_KEY';
    expect(
      runtimeBindingsContentSchema.safeParse(broadEnvironment).success,
    ).toBe(false);

    const dedicatedEnvironment = content();
    dedicatedEnvironment.targets[0]!.provider.apiKeyEnv =
      'STAGEFABRIC_EDGE_API_KEY';
    expect(
      runtimeBindingsContentSchema.safeParse(dedicatedEnvironment).success,
    ).toBe(true);
  });

  it('enforces explicit bounded policies', () => {
    const candidate = content();
    candidate.policy.requestTimeoutMs = 99;
    candidate.policy.maxResponseBytes = 16 * 1_024 * 1_024 + 1;
    candidate.policy.snapshotTtlSeconds = 0;
    expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
      false,
    );
  });

  it('requires a bounded expected embedding dimension', () => {
    const missing = structuredClone(content()) as unknown as {
      targets: { operations: Record<string, unknown>[] }[];
    };
    delete missing.targets[0]!.operations[1]!['expectedDimensions'];
    expect(runtimeBindingsContentSchema.safeParse(missing).success).toBe(false);

    for (const expectedDimensions of [
      0,
      RUNTIME_BINDINGS_LIMITS.expectedDimensions.max + 1,
    ]) {
      const candidate = content();
      const embedding = candidate.targets[0]!.operations[1]!;
      if (embedding.kind !== 'embedding') throw new Error('fixture_invalid');
      embedding.expectedDimensions = expectedDimensions;
      expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
        false,
      );
    }

    for (const expectedDimensions of [
      RUNTIME_BINDINGS_LIMITS.expectedDimensions.min,
      RUNTIME_BINDINGS_LIMITS.expectedDimensions.max,
    ]) {
      const candidate = content();
      const embedding = candidate.targets[0]!.operations[1]!;
      if (embedding.kind !== 'embedding') throw new Error('fixture_invalid');
      embedding.expectedDimensions = expectedDimensions;
      expect(runtimeBindingsContentSchema.safeParse(candidate).success).toBe(
        true,
      );
    }
  });
});

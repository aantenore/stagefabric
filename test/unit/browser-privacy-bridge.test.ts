import { describe, expect, it } from 'vitest';

import {
  BROWSER_RUNTIME_API_VERSION,
  sealBrowserRuntimeBindings,
  type BrowserRuntimeBindings,
} from '../../src/browser/bindings.js';
import type { Sha256Digest } from '../../src/browser/crypto.js';
import { BrowserPrivacyBridge } from '../../src/browser/privacy-bridge.js';
import { issuePrivacyDecisionReceipt } from '../../src/browser/privacy-receipt.js';
import {
  redactWithCascade,
  verifyRedactionResult,
  type RedactionCascadePolicy,
} from '../../src/browser/redaction.js';
import {
  BrowserRuntimeDriverRegistry,
  type BrowserRuntimeDriver,
  type BrowserRuntimeInvocation,
} from '../../src/browser/runtime-driver.js';

const redactionDigest = `sha256:${'b'.repeat(64)}` as Sha256Digest;
const egressDigest = `sha256:${'c'.repeat(64)}` as Sha256Digest;

async function bindings(
  redactionRuleIds: readonly string[] = ['email-rule'],
): Promise<BrowserRuntimeBindings> {
  return sealBrowserRuntimeBindings({
    apiVersion: BROWSER_RUNTIME_API_VERSION,
    kind: 'BrowserRuntimeBindings',
    operatorId: 'operator-a',
    policy: {
      policyId: 'privacy-v1',
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: redactionDigest,
      redactionRuleIds: [...redactionRuleIds],
      redactionClassifierIds: [],
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: egressDigest,
      capabilityProbeTimeoutMs: 100,
      workerReadyTimeoutMs: 500,
      invocationTimeoutMs: 500,
      cleanupTimeoutMs: 100,
      maxInputBytes: 1_024,
      maxOutputBytes: 1_024,
    },
    runtimes: [
      {
        runtimeId: 'runtime-a',
        driverId: 'driver-a',
        worker: { moduleUrl: '/privacy-worker.js', type: 'module' },
        requirements: { secureContext: true, webGpu: false, wasm: false },
        configuration: { privateArtifact: 'never-project-this-value' },
      },
    ],
  });
}

function redactionPolicy(): RedactionCascadePolicy {
  return {
    policyId: 'redaction-v1',
    policyDigest: redactionDigest,
    executionBoundary: 'dedicated-worker',
    maxInputCodeUnits: 1_024,
    maxCandidateSpans: 20,
    defaultClassifierReplacement: '<PRIVATE>',
    rules: [
      {
        ruleId: 'email-rule',
        category: 'email',
        priority: 1,
        pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+',
        replacement: '<EMAIL>',
      },
    ],
  };
}

function driver(
  sealed: BrowserRuntimeBindings,
  options: {
    readonly capabilities?: readonly string[];
    readonly receiptOperation?: string;
    readonly closeThrows?: boolean;
    readonly closeRejects?: boolean;
    readonly closeHangs?: boolean;
    readonly accessorResult?: boolean;
    readonly oversizedOutput?: boolean;
    readonly mutateRuntimeBinding?: boolean;
  } = {},
): BrowserRuntimeDriver {
  return {
    driverId: 'driver-a',
    open: (runtimeBinding) => {
      if (options.mutateRuntimeBinding === true) {
        const configuration = runtimeBinding.configuration as {
          privateArtifact: string;
        };
        configuration.privateArtifact = 'mutated-by-driver';
      }
      return {
        runtimeId: 'runtime-a',
        ready: async () => ({
          runtimeId: 'runtime-a',
          driverId: 'driver-a',
          capabilities: options.capabilities ?? ['sanitize'],
        }),
        invoke: async (request: BrowserRuntimeInvocation) => {
          if (options.accessorResult === true) {
            const malformed = {} as Record<string, unknown>;
            Object.defineProperty(malformed, 'apiVersion', {
              enumerable: true,
              get() {
                throw new Error('SENSITIVE_WORKER_DETAIL');
              },
            });
            return malformed;
          }
          const envelope = request.input as Record<string, string>;
          const redacted = await redactWithCascade(
            envelope['input']!,
            redactionPolicy(),
          );
          const outputVerification = await verifyRedactionResult(
            redacted,
            redactionPolicy(),
          );
          return {
            apiVersion: 'stagefabric.dev/browser-privacy-worker/v1',
            kind: 'BrowserPrivacyWorkerResult',
            output:
              options.oversizedOutput === true
                ? 'x'.repeat(1_025)
                : redacted.output,
            receipt: await issuePrivacyDecisionReceipt({
              decisionId: envelope['decisionId']!,
              planId: envelope['planId']!,
              runtimeId: envelope['runtimeId']!,
              operation: options.receiptOperation ?? envelope['operation']!,
              bindingsDigest: sealed.digest as Sha256Digest,
              redactionPolicyId: 'redaction-v1',
              redactionPolicyDigest: redactionDigest,
              egressPolicyId: 'egress-v1',
              egressPolicyDigest: egressDigest,
              redactionResult: redacted,
              outputVerification,
            }),
          };
        },
        close: (): void | Promise<void> => {
          if (options.closeThrows === true) {
            throw new Error('cleanup-detail-must-not-escape');
          }
          if (options.closeRejects === true) {
            return Promise.resolve().then(() => {
              throw new Error('async-cleanup-detail-must-not-escape');
            });
          }
          if (options.closeHangs === true) {
            return new Promise<void>(() => undefined);
          }
        },
      };
    },
  };
}

function request() {
  return {
    planId: 'plan-1',
    decisionId: 'decision-1',
    runtimeId: 'runtime-a',
    operation: 'sanitize',
    input: 'Email alice@example.test',
  } as const;
}

const capabilityEnvironment = {
  isSecureContext: true,
  gpu: undefined,
  wasm: undefined,
} as const;

describe('BrowserPrivacyBridge', () => {
  it('returns output only after receipt, policy and lineage authorization', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([driver(sealed)]),
      capabilityEnvironment,
    });
    const result = await bridge.execute(request());

    expect(result.output).toBe('Email <EMAIL>');
    expect(result.permit).toMatchObject({
      planId: 'plan-1',
      runtimeId: 'runtime-a',
      operation: 'sanitize',
    });
    expect(result.ledger.events[0]!.evidenceDigests[0]).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(result.ledger.events[0]!.reasonCodes).toEqual(['available']);
    expect(JSON.stringify(result.plan)).not.toContain(
      'never-project-this-value',
    );
    expect(JSON.stringify(result.ledger)).not.toContain('alice@example.test');
  });

  it('snapshots the request before asynchronous binding verification', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([driver(sealed)]),
      capabilityEnvironment,
    });
    const mutable: {
      planId: string;
      decisionId: string;
      runtimeId: string;
      operation: string;
      input: string;
    } = { ...request() };
    const execution = bridge.execute(mutable);
    mutable.planId = 'plan-mutated-after-call';
    mutable.input = 'Email attacker@example.test';

    await expect(execution).resolves.toMatchObject({
      output: 'Email <EMAIL>',
      permit: { planId: 'plan-1' },
    });
  });

  it('recursively freezes the parsed binding before driver execution', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { mutateRuntimeBinding: true }),
      ]),
      capabilityEnvironment,
    });

    await expect(bridge.execute(request())).rejects.toMatchObject({
      code: 'execution_failed',
    });
    expect(sealed.runtimes[0]!.configuration).toEqual({
      privateArtifact: 'never-project-this-value',
    });
  });

  it('fails closed when readiness does not advertise the operation', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { capabilities: ['other-operation'] }),
      ]),
      capabilityEnvironment,
    });
    await expect(bridge.execute(request())).rejects.toMatchObject({
      code: 'execution_failed',
      ledger: {
        events: expect.arrayContaining([
          expect.objectContaining({ reasonCodes: ['execution_failed'] }),
        ]),
      },
    });
  });

  it('rejects a valid receipt from another operation lineage', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { receiptOperation: 'other-operation' }),
      ]),
      capabilityEnvironment,
    });
    await expect(bridge.execute(request())).rejects.toMatchObject({
      code: 'egress_denied',
      ledger: {
        events: expect.arrayContaining([
          expect.objectContaining({ reasonCodes: ['lineage_mismatch'] }),
        ]),
      },
    });
  });

  it('binds planned redaction sources to the sources evaluated by the worker', async () => {
    const sealed = await bindings(['different-rule']);
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([driver(sealed)]),
      capabilityEnvironment,
    });
    await expect(bridge.execute(request())).rejects.toMatchObject({
      code: 'egress_denied',
      ledger: {
        events: expect.arrayContaining([
          expect.objectContaining({
            reasonCodes: ['redaction_source_mismatch'],
          }),
        ]),
      },
    });
  });

  it('normalizes cleanup failures into a denied ledger', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { closeThrows: true }),
      ]),
      capabilityEnvironment,
    });
    const error = await bridge
      .execute(request())
      .catch((value: unknown) =>
        value instanceof Error ? value : new Error('unexpected_test_failure'),
      );
    expect(error).toMatchObject({
      code: 'execution_failed',
      ledger: {
        events: expect.arrayContaining([
          expect.objectContaining({ reasonCodes: ['execution_failed'] }),
        ]),
      },
    });
    expect(JSON.stringify(error)).not.toContain('cleanup-detail');
  });

  it('awaits asynchronous cleanup and fails closed on rejection', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { closeRejects: true }),
      ]),
      capabilityEnvironment,
    });

    await expect(bridge.execute(request())).rejects.toMatchObject({
      code: 'execution_failed',
      ledger: {
        events: expect.arrayContaining([
          expect.objectContaining({ reasonCodes: ['execution_failed'] }),
        ]),
      },
    });
  });

  it('bounds asynchronous cleanup and denies on timeout', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { closeHangs: true }),
      ]),
      capabilityEnvironment,
    });

    await expect(bridge.execute(request())).rejects.toMatchObject({
      code: 'execution_failed',
    });
  });

  it('normalizes accessor-bearing worker results without leaking details', async () => {
    const sealed = await bindings();
    const bridge = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { accessorResult: true }),
      ]),
      capabilityEnvironment,
    });

    const error = await bridge.execute(request()).catch((value) => value);
    expect(error).toMatchObject({ code: 'invalid_worker_result' });
    expect(JSON.stringify(error)).not.toContain('SENSITIVE_WORKER_DETAIL');
  });

  it('rejects obvious UTF-8 input and output overflow without large copies', async () => {
    const sealed = await bindings();
    const normal = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([driver(sealed)]),
      capabilityEnvironment,
    });
    await expect(
      normal.execute({ ...request(), input: 'x'.repeat(1_025) }),
    ).rejects.toMatchObject({ code: 'input_limit_exceeded' });

    const oversized = new BrowserPrivacyBridge({
      bindings: sealed,
      drivers: new BrowserRuntimeDriverRegistry([
        driver(sealed, { oversizedOutput: true }),
      ]),
      capabilityEnvironment,
    });
    await expect(oversized.execute(request())).rejects.toMatchObject({
      code: 'output_limit_exceeded',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { InProcessStageAdapter } from '../../src/adapters/in-process-stage-adapter.js';
import { StageAdapterRegistry } from '../../src/adapters/stage-adapter-registry.js';
import {
  executePlan,
  ExecutionError,
  type ExecutionTraceEvent,
} from '../../src/application/executor.js';
import type {
  ExecutionPlan,
  Placement,
} from '../../src/application/planner.js';
import { sha256Digest } from '../../src/domain/canonical.js';
import { StageAdapterError } from '../../src/ports/stage-adapter.js';
import { StageInputPolicyError } from '../../src/ports/stage-input-guard.js';
import { StageOutputVerificationError } from '../../src/ports/stage-output-verifier.js';

function placement(targetId: string): Placement {
  return {
    targetId,
    zone: 'test-zone',
    adapterKind: 'test',
    rank: { zonePreference: 0, expectedP95Ms: 1, costMicros: 0 },
  };
}

function oneStagePlan(
  fallbacks: readonly Placement[] = [],
  bindingDigest?: string,
): ExecutionPlan {
  const unsigned = {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'ExecutionPlan',
    graphName: 'executor-test',
    evaluatedAt: '2026-07-15T12:00:00.000Z',
    snapshotDigest: `sha256:${'0'.repeat(64)}`,
    ...(bindingDigest === undefined ? {} : { bindingDigest }),
    stages: [
      {
        stageId: 'transform',
        operation: 'transform',
        processingClassification: 'public',
        requiredCapabilities: [],
        requiredResidencies: [],
        inputs: [
          {
            name: 'value',
            ref: 'input.value',
            type: 'text/plain',
            classification: 'public',
            residencies: [],
          },
        ],
        outputs: [
          {
            name: 'result',
            type: 'text/plain',
            classification: 'public',
            residencies: [],
          },
        ],
        primary: placement('primary'),
        fallbacks,
        rejected: [],
      },
    ],
    egress: { proofs: [], digest: `sha256:${'1'.repeat(64)}` },
  } as const;
  return { ...unsigned, digest: sha256Digest(unsigned) };
}

function declassifyingPlan(
  fallbacks: readonly Placement[] = [],
): ExecutionPlan {
  const source = oneStagePlan(fallbacks);
  const { digest: _digest, ...unsigned } = source;
  const stage = source.stages[0]!;
  const declassified = {
    ...unsigned,
    stages: [
      {
        ...stage,
        processingClassification: 'secret',
        outputs: [
          {
            ...stage.outputs[0]!,
            classification: 'public',
            declassification: {
              authorityCapability: 'privacy.declassify',
              justification: 'Output is proven to contain no sensitive data.',
            },
          },
        ],
      },
    ],
  };
  return { ...declassified, digest: sha256Digest(declassified) };
}

async function executionFailure(
  run: () => Promise<unknown>,
): Promise<ExecutionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionError);
    return error as ExecutionError;
  }
  throw new Error('expected execution failure');
}

describe('executePlan', () => {
  it('rejects a mutated plan before invoking an adapter', async () => {
    let calls = 0;
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        calls += 1;
        return { outputs: { result: 'unsafe' } };
      },
    });
    const plan = oneStagePlan();
    const mutated = {
      ...plan,
      graphName: 'mutated-after-planning',
    };

    const error = await executionFailure(() =>
      executePlan({
        plan: mutated,
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );

    expect(error.code).toBe('plan_digest_mismatch');
    expect(error.stageId).toBeUndefined();
    expect(error.trace).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects a different runtime binding before invoking an adapter', async () => {
    let calls = 0;
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        calls += 1;
        return { outputs: { result: 'unsafe' } };
      },
    });
    const expected = `sha256:${'a'.repeat(64)}`;
    const actual = `sha256:${'b'.repeat(64)}`;

    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan([], expected),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter], {
          bindingDigest: actual,
        }),
      }),
    );

    expect(error.code).toBe('binding_digest_mismatch');
    expect(error.stageId).toBeUndefined();
    expect(error.trace).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects a bound adapter registry for an unbound plan', async () => {
    let calls = 0;
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        calls += 1;
        return { outputs: { result: 'unsafe' } };
      },
    });

    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter], {
          bindingDigest: `sha256:${'a'.repeat(64)}`,
        }),
      }),
    );

    expect(error.code).toBe('binding_digest_mismatch');
    expect(error.stageId).toBeUndefined();
    expect(error.trace).toEqual([]);
    expect(calls).toBe(0);
  });

  it('isolates adapter routing from an async guard mutating the caller plan', async () => {
    const plan = oneStagePlan();
    const seen: Array<{ operation: string; targetId: string }> = [];
    let frozenPlacement = false;
    let placementMutationRejected = false;
    const adapter = new InProcessStageAdapter('test', {
      transform: (adapterRequest) => {
        seen.push({
          operation: adapterRequest.operation,
          targetId: adapterRequest.targetId,
        });
        return { outputs: { result: 'safe' } };
      },
    });

    const result = await executePlan({
      plan,
      inputs: { value: 'input' },
      adapters: new StageAdapterRegistry([adapter]),
      guards: [
        {
          inspect: async (guardRequest) => {
            const placementRank = (
              guardRequest.placement as unknown as { rank: object }
            ).rank;
            frozenPlacement =
              Object.isFrozen(guardRequest.placement) &&
              Object.isFrozen(placementRank);
            try {
              (guardRequest.placement as { targetId: string }).targetId =
                'guard-controlled';
            } catch {
              placementMutationRejected = true;
            }

            const mutablePlan = plan as unknown as {
              stages: Array<{
                operation: string;
                primary: { targetId: string };
              }>;
            };
            mutablePlan.stages[0]!.operation = 'guard-controlled';
            mutablePlan.stages[0]!.primary.targetId = 'guard-controlled';
            await Promise.resolve();
          },
        },
      ],
    });

    expect(frozenPlacement).toBe(true);
    expect(placementMutationRejected).toBe(true);
    expect(seen).toEqual([{ operation: 'transform', targetId: 'primary' }]);
    expect(result.values['transform.result']).toBe('safe');
    expect(plan.stages[0]!.operation).toBe('guard-controlled');
  });

  it('isolates nested caller data across every guard and the adapter', async () => {
    const callerInput = {
      nested: { value: 'original' },
      items: ['original'],
    };
    const observations: string[] = [];
    const adapter = new InProcessStageAdapter('test', {
      transform: (request) => {
        const value = request.inputs.value as typeof callerInput;
        observations.push(
          `adapter:${value.nested.value}:${value.items.join()}`,
        );
        value.nested.value = 'adapter-mutated';
        value.items.push('adapter-mutated');
        return { outputs: { result: 'safe' } };
      },
    });

    const result = await executePlan({
      plan: oneStagePlan(),
      inputs: { value: callerInput },
      adapters: new StageAdapterRegistry([adapter]),
      guards: [
        {
          inspect: (request) => {
            const value = request.inputs.value as typeof callerInput;
            observations.push(`guard-1:${value.nested.value}`);
            value.nested.value = 'guard-mutated';
            value.items.push('guard-mutated');
          },
        },
        {
          inspect: (request) => {
            const value = request.inputs.value as typeof callerInput;
            observations.push(
              `guard-2:${value.nested.value}:${value.items.join()}`,
            );
          },
        },
      ],
    });

    expect(observations).toEqual([
      'guard-1:original',
      'guard-2:original:original',
      'adapter:original:original',
    ]);
    expect(callerInput).toEqual({
      nested: { value: 'original' },
      items: ['original'],
    });
    expect(result.values['transform.result']).toBe('safe');
  });

  it('rebuilds pristine nested inputs for a fallback attempt', async () => {
    const callerInput = { nested: { value: 'original' } };
    const observations: string[] = [];
    const adapter = new InProcessStageAdapter('test', {
      'primary:transform': (request) => {
        const value = request.inputs.value as typeof callerInput;
        observations.push(`primary:${value.nested.value}`);
        value.nested.value = 'primary-mutated';
        throw new StageAdapterError({
          code: 'upstream_unavailable',
          statusCode: 503,
          outputEmitted: false,
        });
      },
      'fallback:transform': (request) => {
        const value = request.inputs.value as typeof callerInput;
        observations.push(`fallback:${value.nested.value}`);
        return { outputs: { result: value.nested.value } };
      },
    });

    const result = await executePlan({
      plan: oneStagePlan([placement('fallback')]),
      inputs: { value: callerInput },
      adapters: new StageAdapterRegistry([adapter]),
    });

    expect(observations).toEqual(['primary:original', 'fallback:original']);
    expect(callerInput.nested.value).toBe('original');
    expect(result.values['transform.result']).toBe('original');
  });

  it('rejects accessor-bearing input without invoking the accessor', async () => {
    let getterCalls = 0;
    let adapterCalls = 0;
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        adapterCalls += 1;
        return { outputs: { result: 'unsafe' } };
      },
    });

    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );

    expect(error.code).toBe('input_policy_rejected');
    expect(error.reasonCode).toBe('input_snapshot_invalid');
    expect(getterCalls).toBe(0);
    expect(adapterCalls).toBe(0);
  });

  it.each([
    [
      'a custom prototype',
      () => Object.assign(Object.create({ inherited: 'unsafe' }), { ok: true }),
    ],
    [
      'a cycle',
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
  ])('rejects input with %s', async (_label, createValue) => {
    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs: { result: 'unsafe' } }),
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: createValue() },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.code).toBe('input_policy_rejected');
    expect(error.reasonCode).toBe('input_snapshot_invalid');
  });

  it('enforces configurable snapshot depth and node limits before execution', async () => {
    let calls = 0;
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        calls += 1;
        return { outputs: { result: 'unsafe' } };
      },
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: { nested: { tooDeep: true } } },
        adapters: new StageAdapterRegistry([adapter]),
        snapshotLimits: { maxDepth: 2, maxNodes: 100 },
      }),
    );
    expect(error.code).toBe('input_policy_rejected');
    expect(error.reasonCode).toBe('input_snapshot_invalid');
    expect(calls).toBe(0);
  });

  it('charges sparse array length to the snapshot budget before execution', async () => {
    let calls = 0;
    const sparse: unknown[] = [];
    sparse.length = 1_000_000;
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        calls += 1;
        return { outputs: { result: 'unsafe' } };
      },
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: sparse },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.code).toBe('input_policy_rejected');
    expect(error.reasonCode).toBe('input_snapshot_invalid');
    expect(calls).toBe(0);
  });

  it('uses the ordered fallback only for allowlisted failures before output', async () => {
    const calls: string[] = [];
    const adapter = new InProcessStageAdapter('test', {
      'primary:transform': (request) => {
        calls.push(request.targetId);
        throw new StageAdapterError({
          code: 'upstream_unavailable',
          statusCode: 503,
          outputEmitted: false,
        });
      },
      'fallback:transform': (request) => {
        calls.push(request.targetId);
        return { outputs: { result: 'ok' } };
      },
    });

    const result = await executePlan({
      plan: oneStagePlan([placement('fallback')]),
      inputs: { value: 'safe' },
      adapters: new StageAdapterRegistry([adapter]),
    });

    expect(calls).toEqual(['primary', 'fallback']);
    expect(result.values['transform.result']).toBe('ok');
    expect(result.trace.map((event) => event.reasonCode)).toEqual([
      'retryable_pre_output_status',
      'completed',
    ]);
  });

  it('captures guard methods before a retryable adapter can mutate them', async () => {
    let secretReleased = false;
    const guard = {
      deniedTarget: 'fallback',
      inspect(request: { placement: { targetId: string } }) {
        if (request.placement.targetId === this.deniedTarget) {
          throw new StageInputPolicyError('sensitive_data_detected');
        }
      },
    };
    const adapter = new InProcessStageAdapter('test', {
      'primary:transform': () => {
        guard.inspect = () => undefined;
        throw new StageAdapterError({
          code: 'upstream_unavailable',
          statusCode: 503,
          outputEmitted: false,
        });
      },
      'fallback:transform': (request) => {
        secretReleased = request.inputs.value === 'source-secret';
        return { outputs: { result: 'unsafe' } };
      },
    });

    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan([placement('fallback')]),
        inputs: { value: 'source-secret' },
        adapters: new StageAdapterRegistry([adapter]),
        guards: [guard],
      }),
    );

    expect(error.code).toBe('input_policy_rejected');
    expect(error.reasonCode).toBe('sensitive_data_detected');
    expect(error.trace.map((event) => event.reasonCode)).toEqual([
      'retryable_pre_output_status',
      'input_policy_rejected',
    ]);
    expect(secretReleased).toBe(false);
  });

  it.each([
    [
      'an ambiguous timeout',
      new StageAdapterError({ code: 'timeout', outputEmitted: false }),
    ],
    [
      'a partial output',
      new StageAdapterError({
        code: 'partial_output',
        statusCode: 503,
        outputEmitted: true,
      }),
    ],
  ])('does not replay %s', async (_label, failure) => {
    let fallbackCalls = 0;
    const adapter = new InProcessStageAdapter('test', {
      'primary:transform': () => {
        throw failure;
      },
      'fallback:transform': () => {
        fallbackCalls += 1;
        return { outputs: { result: 'unsafe-replay' } };
      },
    });

    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan([placement('fallback')]),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.code).toBe('adapter_failed');
    expect(fallbackCalls).toBe(0);
  });

  it('requires the exact planned output keys', async () => {
    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs: { result: 'ok', surprise: 'not-planned' } }),
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.code).toBe('invalid_outputs');
  });

  it('rejects accessor-bearing adapter output without invoking the accessor', async () => {
    let getterCalls = 0;
    const outputs = {} as Record<string, unknown>;
    Object.defineProperty(outputs, 'result', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs }),
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.code).toBe('invalid_outputs');
    expect(getterCalls).toBe(0);
  });

  it('fails closed when a declassification has no output verifier', async () => {
    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs: { result: 'redacted' } }),
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: declassifyingPlan(),
        inputs: { value: 'secret' },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.code).toBe('output_policy_rejected');
    expect(error.reasonCode).toBe('declassification_verifier_missing');
    expect(error.trace.at(-1)?.reasonCode).toBe('output_policy_rejected');
  });

  it('allows only immutable input-policy reason codes and rejects forged errors', async () => {
    expect(
      () => new StageInputPolicyError('token=must-not-leak' as never),
    ).toThrow('stage_input_policy_reason_invalid');
    const policyError = new StageInputPolicyError('policy_unavailable');
    expect(
      () =>
        ((policyError as { reasonCode: string }).reasonCode =
          'token=must-not-leak'),
    ).toThrow();

    const forged = Object.create(StageInputPolicyError.prototype) as {
      reasonCode: string;
    };
    forged.reasonCode = 'token=must-not-leak';
    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs: { result: 'safe' } }),
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter]),
        guards: [{ inspect: () => Promise.reject(forged) }],
      }),
    );
    expect(error.reasonCode).toBe('guard_failed');
    expect(JSON.stringify(error)).not.toContain('must-not-leak');
  });

  it('snapshots, validates and freezes adapter error metadata', async () => {
    let codeReads = 0;
    const options = {
      get code() {
        codeReads += 1;
        return codeReads === 1 ? 'upstream_unavailable' : 'token=must-not-leak';
      },
      statusCode: 503,
      outputEmitted: false,
    } as never;
    const structured = new StageAdapterError(options);
    expect(codeReads).toBe(1);
    expect(structured.code).toBe('upstream_unavailable');
    expect(
      () => ((structured as { code: string }).code = 'token=must-not-leak'),
    ).toThrow();

    const forged = Object.create(StageAdapterError.prototype) as {
      code: string;
      outputEmitted: boolean;
      statusCode: number;
    };
    Object.assign(forged, {
      code: 'token=must-not-leak',
      outputEmitted: false,
      statusCode: 503,
    });
    const adapter = new InProcessStageAdapter('test', {
      transform: () => Promise.reject(forged),
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: 'safe' },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );
    expect(error.reasonCode).toBe('unexpected_adapter_failure');
    expect(JSON.stringify(error)).not.toContain('must-not-leak');
  });

  it('requires an explicit true result from the output verifier', async () => {
    let fallbackCalls = 0;
    const adapter = new InProcessStageAdapter('test', {
      'primary:transform': () => ({ outputs: { result: 'not-redacted' } }),
      'fallback:transform': () => {
        fallbackCalls += 1;
        return { outputs: { result: 'unsafe-fallback' } };
      },
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: declassifyingPlan([placement('fallback')]),
        inputs: { value: 'secret' },
        adapters: new StageAdapterRegistry([adapter]),
        outputVerifier: { verify: () => false },
      }),
    );
    expect(error.code).toBe('output_policy_rejected');
    expect(error.reasonCode).toBe('declassification_verification_failed');
    expect(fallbackCalls).toBe(0);
  });

  it('captures the verifier method before asynchronous adapter work', async () => {
    const verifier = {
      verify() {
        return this === verifier;
      },
    };
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        verifier.verify = () => false;
        return { outputs: { result: 'redacted' } };
      },
    });

    await expect(
      executePlan({
        plan: declassifyingPlan(),
        inputs: { value: 'secret' },
        adapters: new StageAdapterRegistry([adapter]),
        outputVerifier: verifier,
      }),
    ).resolves.toMatchObject({
      values: { 'transform.result': 'redacted' },
    });
  });

  it('passes declassification metadata and disposable snapshots to the verifier', async () => {
    const callerInput = { nested: { secret: 'source-secret' } };
    const adapterOutput = { nested: { text: 'redacted' } };
    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs: { result: adapterOutput } }),
    });
    const result = await executePlan({
      plan: declassifyingPlan(),
      inputs: { value: callerInput },
      adapters: new StageAdapterRegistry([adapter]),
      outputVerifier: {
        verify: (request) => {
          expect(request.output).toEqual({
            name: 'result',
            type: 'text/plain',
            fromClassification: 'secret',
            classification: 'public',
            authorityCapability: 'privacy.declassify',
            justification: 'Output is proven to contain no sensitive data.',
          });
          const input = request.inputs.value as typeof callerInput;
          const value = request.value as typeof adapterOutput;
          expect(input.nested.secret).toBe('source-secret');
          expect(value.nested.text).toBe('redacted');
          input.nested.secret = 'verifier-mutated';
          value.nested.text = 'verifier-mutated';
          return true;
        },
      },
    });

    expect(callerInput.nested.secret).toBe('source-secret');
    expect(adapterOutput.nested.text).toBe('redacted');
    expect(result.values['transform.result']).toEqual({
      nested: { text: 'redacted' },
    });
  });

  it('keeps allowlisted verifier errors while hiding unexpected details', async () => {
    expect(
      () =>
        new StageOutputVerificationError(
          'secret=must-not-become-a-reason-code' as never,
        ),
    ).toThrow('stage_output_verification_reason_invalid');

    const immutablePolicyError = new StageOutputVerificationError(
      'redaction_proof_invalid',
    );
    expect(
      () =>
        ((immutablePolicyError as { reasonCode: string }).reasonCode =
          'token=must-not-leak'),
    ).toThrow();

    const adapter = new InProcessStageAdapter('test', {
      transform: () => ({ outputs: { result: 'redacted' } }),
    });
    const policyError = await executionFailure(() =>
      executePlan({
        plan: declassifyingPlan(),
        inputs: { value: 'secret' },
        adapters: new StageAdapterRegistry([adapter]),
        outputVerifier: {
          verify: () => {
            throw new StageOutputVerificationError('redaction_proof_invalid');
          },
        },
      }),
    );
    expect(policyError.reasonCode).toBe('redaction_proof_invalid');

    const unexpected = await executionFailure(() =>
      executePlan({
        plan: declassifyingPlan(),
        inputs: { value: 'secret' },
        adapters: new StageAdapterRegistry([adapter]),
        outputVerifier: {
          verify: () => {
            throw new Error('credential=must-not-leak');
          },
        },
      }),
    );
    expect(unexpected.reasonCode).toBe('output_verifier_failed');
    expect(JSON.stringify(unexpected)).not.toContain('must-not-leak');
  });

  it('emits only allowlisted trace metadata, never raw adapter errors', async () => {
    const secret =
      'token=secret at https://internal.invalid for ada@example.com';
    const adapter = new InProcessStageAdapter('test', {
      transform: () => {
        throw new Error(secret);
      },
    });
    const error = await executionFailure(() =>
      executePlan({
        plan: oneStagePlan(),
        inputs: { value: secret },
        adapters: new StageAdapterRegistry([adapter]),
      }),
    );

    const allowedKeys = new Set<keyof ExecutionTraceEvent>([
      'stageId',
      'targetId',
      'zone',
      'adapterKind',
      'attempt',
      'outcome',
      'reasonCode',
      'statusCode',
    ]);
    for (const event of error.trace) {
      expect(
        Object.keys(event).every((key) =>
          allowedKeys.has(key as keyof ExecutionTraceEvent),
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(error.trace)).not.toContain(secret);
    expect(JSON.stringify(error.trace)).not.toContain('https://');
    expect(JSON.stringify(error.trace)).not.toContain('ada@example.com');
  });
});

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
import { StageAdapterError } from '../../src/ports/stage-adapter.js';

function placement(targetId: string): Placement {
  return {
    targetId,
    zone: 'test-zone',
    adapterKind: 'test',
    rank: { zonePreference: 0, expectedP95Ms: 1, costMicros: 0 },
  };
}

function oneStagePlan(fallbacks: readonly Placement[] = []): ExecutionPlan {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'ExecutionPlan',
    graphName: 'executor-test',
    evaluatedAt: '2026-07-15T12:00:00.000Z',
    snapshotDigest: `sha256:${'0'.repeat(64)}`,
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
    digest: `sha256:${'2'.repeat(64)}`,
  };
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

import { describe, expect, it, vi } from 'vitest';

import { PlannerError } from '../../src/application/planner.js';
import {
  LiveRunnerError,
  runLiveStageGraph,
} from '../../src/composition/live-runner.js';
import { sealRuntimeBindings } from '../../src/domain/runtime-bindings.js';

function fabric(targetIds: readonly string[]) {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'Fabric',
    zones: [{ id: 'edge', trustLevel: 1, residencies: ['EU'], labels: {} }],
    classifications: [
      {
        id: 'public',
        rank: 0,
        minTrustLevel: 0,
        allowedZones: [],
        allowedResidencies: [],
      },
    ],
    targets: targetIds.map((id, index) => ({
      id,
      zone: 'edge',
      adapter: { kind: 'openai-compatible' },
      capabilities: ['text-generation'],
      expectedP95Ms: index + 1,
      costMicros: 0,
      labels: {},
    })),
    policy: { zonePreference: ['edge'], maxFallbacks: 1 },
  } as const;
}

const graph = {
  apiVersion: 'stagefabric.dev/v1alpha1',
  kind: 'StageGraph',
  metadata: { name: 'live-summary', labels: {} },
  inputs: [
    {
      name: 'prompt',
      type: 'text/plain',
      classification: 'public',
      residencies: ['EU'],
      origin: { zone: 'edge' },
    },
  ],
  stages: [
    {
      id: 'summarize',
      operation: 'summarize',
      inputs: { prompt: { ref: 'input.prompt', type: 'text/plain' } },
      outputs: [
        { name: 'answer', type: 'text/plain', classification: 'public' },
      ],
      requirements: {
        capabilities: ['text-generation'],
        allowedZones: [],
        residencies: [],
      },
      declassifications: [],
    },
  ],
} as const;

function bindings(
  targets: readonly {
    targetId: string;
    model: string;
    extraOperation?: boolean;
  }[],
  policy: { snapshotTtlSeconds?: number } = {},
) {
  return sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 1_000,
      maxResponseBytes: 16_384,
      snapshotTtlSeconds: policy.snapshotTtlSeconds ?? 60,
    },
    targets: targets.map((target) => ({
      targetId: target.targetId,
      provider: {
        kind: 'openai-compatible',
        name: target.targetId,
        baseUrl: `https://${target.targetId}.invalid/v1`,
      },
      operations: [
        {
          kind: 'generate-text',
          operation: 'summarize',
          capabilities: ['text-generation'],
          model: target.model,
          input: 'prompt',
          output: 'answer',
        },
        ...(target.extraOperation === true
          ? [
              {
                kind: 'generate-text' as const,
                operation: 'translate',
                capabilities: ['text-generation'],
                model: 'translate-live',
                input: 'prompt',
                output: 'answer',
              },
            ]
          : []),
      ],
    })),
  });
}

function url(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

describe('Live Fabric Runner', () => {
  it('uses a fresh model probe to place and execute the exact bound operation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const requestUrl = url(input);
      if (requestUrl.pathname === '/v1/models') {
        return Response.json({
          data: [
            {
              id:
                requestUrl.hostname === 'edge-a.invalid'
                  ? 'different-model'
                  : 'summary-live',
            },
          ],
        });
      }
      if (
        requestUrl.hostname === 'edge-b.invalid' &&
        requestUrl.pathname === '/v1/chat/completions'
      ) {
        return Response.json({
          choices: [
            {
              message: { role: 'assistant', content: 'Bound answer.' },
              finish_reason: 'stop',
            },
          ],
        });
      }
      throw new Error('unexpected_request');
    });
    const sealed = bindings([
      { targetId: 'edge-a', model: 'summary-live' },
      { targetId: 'edge-b', model: 'summary-live' },
    ]);

    const result = await runLiveStageGraph(
      {
        fabric: fabric(['edge-a', 'edge-b']),
        graph,
        bindings: sealed,
        inputs: { prompt: 'Summarize this.' },
      },
      {
        now: () => new Date('2026-07-15T12:00:00.000Z'),
        environment: {},
        fetch,
      },
    );

    expect(result.bindingDigest).toBe(sealed.digest);
    expect(result.snapshot.bindingDigest).toBe(sealed.digest);
    expect(result.plan.bindingDigest).toBe(sealed.digest);
    expect(result.plan.stages[0]?.primary.targetId).toBe('edge-b');
    expect(result.outputs).toEqual({ 'summarize.answer': 'Bound answer.' });
    expect(result.execution.trace).toEqual([
      expect.objectContaining({
        stageId: 'summarize',
        targetId: 'edge-b',
        reasonCode: 'completed',
      }),
    ]);
    expect(JSON.stringify(result.execution.trace)).not.toContain(
      'Summarize this.',
    );
    expect(JSON.stringify(result)).not.toContain('Summarize this.');
    expect(result.execution).not.toHaveProperty('values');
    expect(result.execution.stages[0]).not.toHaveProperty('outputs');
  });

  it('does not confuse a shared capability from another live operation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const requestUrl = url(input);
      if (requestUrl.pathname === '/v1/models') {
        return Response.json({ data: [{ id: 'translate-live' }] });
      }
      throw new Error('execution_must_not_start');
    });

    await expect(
      runLiveStageGraph(
        {
          fabric: fabric(['edge-a']),
          graph,
          bindings: bindings([
            {
              targetId: 'edge-a',
              model: 'summary-missing',
              extraOperation: true,
            },
          ]),
          inputs: { prompt: 'Summarize this.' },
        },
        {
          now: () => new Date('2026-07-15T12:00:00.000Z'),
          environment: {},
          fetch,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlannerError>>({
        code: 'no_eligible_target',
      }),
    );
    expect(
      fetch.mock.calls.every(([input]) => url(input).pathname === '/v1/models'),
    ).toBe(true);
  });

  it('expires a snapshot when the trusted clock advances during the probe', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (url(input).pathname === '/v1/models') {
        return Response.json({ data: [{ id: 'summary-live' }] });
      }
      throw new Error('inference_must_not_start');
    });
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date('2026-07-15T12:00:00.000Z'))
      .mockReturnValueOnce(new Date('2026-07-15T12:00:01.000Z'));

    await expect(
      runLiveStageGraph(
        {
          fabric: fabric(['edge-a']),
          graph,
          bindings: bindings([{ targetId: 'edge-a', model: 'summary-live' }], {
            snapshotTtlSeconds: 1,
          }),
          inputs: { prompt: 'Summarize this.' },
        },
        { now, environment: {}, fetch },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlannerError>>({
        code: 'snapshot_expired',
      }),
    );
    expect(now).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(url(fetch.mock.calls[0]![0]).pathname).toBe('/v1/models');
  });

  it('rejects the internal operation namespace as declassification authority before I/O', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const secretFabric = {
      ...structuredClone(fabric(['edge-a'])),
      classifications: [
        {
          id: 'public',
          rank: 0,
          minTrustLevel: 0,
          allowedZones: [],
          allowedResidencies: [],
        },
        {
          id: 'secret',
          rank: 1,
          minTrustLevel: 1,
          allowedZones: [],
          allowedResidencies: [],
        },
      ],
    };
    const unsafeGraph = {
      ...structuredClone(graph),
      inputs: graph.inputs.map((input) => ({
        ...structuredClone(input),
        classification: 'secret',
      })),
      stages: graph.stages.map((stage) => ({
        ...structuredClone(stage),
        outputs: stage.outputs.map((output) => ({
          ...structuredClone(output),
          classification: 'public',
        })),
        declassifications: [
          {
            output: 'answer',
            toClassification: 'public',
            authorityCapability: 'stagefabric.operation/summarize',
            justification: 'Synthetic evidence is not authority.',
          },
        ],
      })),
    };

    await expect(
      runLiveStageGraph(
        {
          fabric: secretFabric,
          graph: unsafeGraph,
          bindings: bindings([{ targetId: 'edge-a', model: 'summary-live' }]),
          inputs: { prompt: 'secret' },
        },
        { fetch },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects all live declassification until a trusted output verifier exists', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const secretFabric = {
      ...structuredClone(fabric(['edge-a'])),
      classifications: [
        {
          id: 'public',
          rank: 0,
          minTrustLevel: 0,
          allowedZones: [],
          allowedResidencies: [],
        },
        {
          id: 'secret',
          rank: 1,
          minTrustLevel: 1,
          allowedZones: [],
          allowedResidencies: [],
        },
      ],
      targets: fabric(['edge-a']).targets.map((target) => ({
        ...structuredClone(target),
        capabilities: ['text-generation', 'privacy.declassify'],
      })),
    };
    const unsafeGraph = {
      ...structuredClone(graph),
      inputs: graph.inputs.map((input) => ({
        ...structuredClone(input),
        classification: 'secret',
      })),
      stages: graph.stages.map((stage) => ({
        ...structuredClone(stage),
        outputs: stage.outputs.map((output) => ({
          ...structuredClone(output),
          classification: 'public',
        })),
        declassifications: [
          {
            output: 'answer',
            toClassification: 'public',
            authorityCapability: 'privacy.declassify',
            justification: 'A model response is not verified redaction.',
          },
        ],
      })),
    };
    const sealed = sealRuntimeBindings({
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'RuntimeBindings',
      policy: {
        requestTimeoutMs: 1_000,
        maxResponseBytes: 16_384,
        snapshotTtlSeconds: 60,
      },
      targets: [
        {
          targetId: 'edge-a',
          provider: {
            kind: 'openai-compatible',
            name: 'edge-a',
            baseUrl: 'https://edge-a.invalid/v1',
          },
          operations: [
            {
              kind: 'generate-text',
              operation: 'summarize',
              capabilities: ['text-generation', 'privacy.declassify'],
              model: 'summary-live',
              input: 'prompt',
              output: 'answer',
            },
          ],
        },
      ],
    });

    await expect(
      runLiveStageGraph(
        {
          fabric: secretFabric,
          graph: unsafeGraph,
          bindings: sealed,
          inputs: { prompt: 'SECRET-SENTINEL' },
        },
        { fetch },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LiveRunnerError>>({
        code: 'live_declassification_unsupported',
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['generate-text', 'vector/f32'],
    ['embedding', 'text/plain'],
  ] as const)(
    'rejects a %s binding with an incompatible graph output type',
    async (kind, outputType) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const mismatchedGraph = {
        ...structuredClone(graph),
        stages: graph.stages.map((stage) => ({
          ...structuredClone(stage),
          operation: kind === 'embedding' ? 'embed' : 'summarize',
          outputs: stage.outputs.map((output) => ({
            ...structuredClone(output),
            type: outputType,
          })),
        })),
      };
      const sealed = sealRuntimeBindings({
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'RuntimeBindings',
        policy: {
          requestTimeoutMs: 1_000,
          maxResponseBytes: 16_384,
          snapshotTtlSeconds: 60,
        },
        targets: [
          {
            targetId: 'edge-a',
            provider: {
              kind: 'openai-compatible',
              name: 'edge-a',
              baseUrl: 'https://edge-a.invalid/v1',
            },
            operations: [
              {
                kind,
                operation: kind === 'embedding' ? 'embed' : 'summarize',
                capabilities: ['text-generation'],
                model: 'model',
                input: 'prompt',
                output: 'answer',
                ...(kind === 'embedding' ? { expectedDimensions: 3 } : {}),
              },
            ],
          },
        ],
      });

      await expect(
        runLiveStageGraph(
          {
            fabric: fabric(['edge-a']),
            graph: mismatchedGraph,
            bindings: sealed,
            inputs: { prompt: 'text' },
          },
          { fetch },
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<LiveRunnerError>>({
          code: 'operation_contract_mismatch',
        }),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects tampered bindings and input drift before network I/O', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sealed = bindings([{ targetId: 'edge-a', model: 'summary-live' }]);
    const tampered = {
      ...sealed,
      targets: [
        {
          ...sealed.targets[0]!,
          provider: {
            ...sealed.targets[0]!.provider,
            baseUrl: 'https://changed.invalid/v1',
          },
        },
      ],
    };

    await expect(
      runLiveStageGraph(
        {
          fabric: fabric(['edge-a']),
          graph,
          bindings: tampered,
          inputs: { prompt: 'secret' },
        },
        { fetch },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LiveRunnerError>>({
        code: 'binding_digest_mismatch',
      }),
    );
    const inputError = await runLiveStageGraph(
      {
        fabric: fabric(['edge-a']),
        graph,
        bindings: sealed,
        inputs: { 'secret-key-do-not-leak': 'secret' },
      },
      { fetch },
    ).catch((error: unknown) => error);
    expect(inputError).toEqual(
      expect.objectContaining<Partial<LiveRunnerError>>({
        code: 'input_contract_mismatch',
      }),
    );
    expect(JSON.stringify(inputError)).not.toContain('secret-key-do-not-leak');
    expect(fetch).not.toHaveBeenCalled();
  });
});

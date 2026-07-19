import { describe, expect, it, vi } from 'vitest';

import {
  createExecutionPlacementEvidence,
  ExecutionPlacementEvidenceCreationError,
} from '../../src/composition/execution-placement-evidence.js';
import type { LiveRunResult } from '../../src/composition/live-runner.js';
import { runLiveStageGraph } from '../../src/composition/live-runner.js';
import { sha256Digest } from '../../src/domain/canonical.js';
import {
  EXECUTION_PLACEMENT_EVIDENCE_MEDIA_TYPE,
  ExecutionPlacementEvidenceError,
  executionPlacementEvidenceSchema,
  parseExecutionPlacementEvidence,
  verifyExecutionPlacementEvidenceDigest,
} from '../../src/domain/execution-placement-evidence.js';
import { sealRuntimeBindings } from '../../src/domain/runtime-bindings.js';

const RAW_RUN_ID = 'run-id-sentinel-never-store';
const RAW_INPUT = 'input-sentinel-never-store-or-hash';
const RAW_OUTPUT = 'output-sentinel-never-store-or-hash';
const RAW_STAGE_ID = 'stage-id-sentinel';
const RAW_TARGET_ID = 'target-id-sentinel';
const RAW_ZONE = 'zone-id-sentinel';
const RAW_MODEL = 'model-id-sentinel';
const RAW_ENDPOINT_HOST = 'endpoint-sentinel.invalid';
const OBSERVED_AT = '2026-07-19T15:00:01.000Z';

async function successfulLiveResult(): Promise<LiveRunResult> {
  const bindings = sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 1_000,
      maxResponseBytes: 16_384,
      snapshotTtlSeconds: 60,
    },
    targets: [
      {
        targetId: RAW_TARGET_ID,
        provider: {
          kind: 'openai-compatible',
          name: 'provider-id-sentinel',
          baseUrl: `https://${RAW_ENDPOINT_HOST}/v1`,
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'generate',
            capabilities: ['text-generation'],
            model: RAW_MODEL,
            input: 'prompt',
            output: 'text',
          },
        ],
      },
    ],
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.pathname === '/v1/models') {
      return Response.json({ data: [{ id: RAW_MODEL }] });
    }
    if (url.pathname === '/v1/chat/completions') {
      return Response.json({
        choices: [
          {
            message: { role: 'assistant', content: RAW_OUTPUT },
            finish_reason: 'stop',
          },
        ],
      });
    }
    throw new Error('unexpected_request');
  });

  return runLiveStageGraph(
    {
      fabric: {
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'Fabric',
        zones: [
          { id: RAW_ZONE, trustLevel: 1, residencies: ['EU'], labels: {} },
        ],
        classifications: [
          {
            id: 'public',
            rank: 0,
            minTrustLevel: 0,
            allowedZones: [],
            allowedResidencies: [],
          },
        ],
        targets: [
          {
            id: RAW_TARGET_ID,
            zone: RAW_ZONE,
            adapter: { kind: 'openai-compatible' },
            capabilities: ['text-generation'],
            expectedP95Ms: 1,
            costMicros: 0,
            labels: {},
          },
        ],
        policy: { zonePreference: [RAW_ZONE], maxFallbacks: 0 },
      },
      graph: {
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'StageGraph',
        metadata: { name: 'evidence-test', labels: {} },
        inputs: [
          {
            name: 'prompt',
            type: 'text/plain',
            classification: 'public',
            residencies: ['EU'],
            origin: { zone: RAW_ZONE },
          },
        ],
        stages: [
          {
            id: RAW_STAGE_ID,
            operation: 'generate',
            inputs: {
              prompt: { ref: 'input.prompt', type: 'text/plain' },
            },
            outputs: [
              {
                name: 'text',
                type: 'text/plain',
                classification: 'public',
              },
            ],
            requirements: {
              capabilities: ['text-generation'],
              allowedZones: [],
              residencies: [],
            },
            declassifications: [],
          },
        ],
      },
      bindings,
      inputs: { prompt: RAW_INPUT },
    },
    {
      now: () => new Date('2026-07-19T15:00:00.000Z'),
      environment: {},
      fetch,
    },
  );
}

describe('ExecutionPlacementEvidence', () => {
  it('projects a successful live result into strict observation-only evidence', async () => {
    const result = await successfulLiveResult();
    const evidence = createExecutionPlacementEvidence({
      runId: RAW_RUN_ID,
      observedAt: OBSERVED_AT,
      result,
    });

    expect(EXECUTION_PLACEMENT_EVIDENCE_MEDIA_TYPE).toBe(
      'application/vnd.stagefabric.execution-placement-evidence+json',
    );
    expect(evidence).toMatchObject({
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'ExecutionPlacementEvidence',
      producer: 'stagefabric',
      disclosure: 'content-free',
      authority: 'observation-only',
      runIdDigest: sha256Digest(RAW_RUN_ID),
      observedAt: OBSERVED_AT,
      planDigest: result.plan.digest,
      bindingDigest: result.bindingDigest,
      snapshotDigest: result.snapshot.digest,
      egressDigest: result.plan.egress.digest,
      placements: [
        {
          stageIdDigest: sha256Digest(RAW_STAGE_ID),
          targetIdDigest: sha256Digest(RAW_TARGET_ID),
          zoneDigest: sha256Digest(RAW_ZONE),
          adapterKindDigest: sha256Digest('openai-compatible'),
          attempt: 1,
          status: 'succeeded',
          reasonCode: 'completed',
        },
      ],
      trace: [
        {
          stageIdDigest: sha256Digest(RAW_STAGE_ID),
          targetIdDigest: sha256Digest(RAW_TARGET_ID),
          zoneDigest: sha256Digest(RAW_ZONE),
          adapterKindDigest: sha256Digest('openai-compatible'),
          attempt: 1,
          status: 'succeeded',
          reasonCode: 'completed',
        },
      ],
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(executionPlacementEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );
    expect(verifyExecutionPlacementEvidenceDigest(evidence)).toBe(true);
    expect(parseExecutionPlacementEvidence(evidence)).toEqual(evidence);
  });

  it('retains neither sensitive values nor raw placement identifiers', async () => {
    const evidence = createExecutionPlacementEvidence({
      runId: RAW_RUN_ID,
      observedAt: OBSERVED_AT,
      result: await successfulLiveResult(),
    });
    const serialized = JSON.stringify(evidence);

    for (const sentinel of [
      RAW_RUN_ID,
      RAW_INPUT,
      RAW_OUTPUT,
      RAW_STAGE_ID,
      RAW_TARGET_ID,
      RAW_ZONE,
      RAW_MODEL,
      RAW_ENDPOINT_HOST,
      'provider-id-sentinel',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(serialized).not.toContain(sha256Digest(RAW_INPUT));
    expect(serialized).not.toContain(sha256Digest(RAW_OUTPUT));
  });

  it('changes only the run binding when the host run identifier changes', async () => {
    const result = await successfulLiveResult();
    const first = createExecutionPlacementEvidence({
      runId: 'run-a',
      observedAt: OBSERVED_AT,
      result,
    });
    const second = createExecutionPlacementEvidence({
      runId: 'run-b',
      observedAt: OBSERVED_AT,
      result,
    });

    expect(first.runIdDigest).not.toBe(second.runIdDigest);
    expect(first.digest).not.toBe(second.digest);
    expect({
      ...first,
      runIdDigest: second.runIdDigest,
      digest: second.digest,
    }).toEqual(second);
  });

  it('detects mutation, unknown fields, and incoherent live results', async () => {
    const result = await successfulLiveResult();
    const evidence = createExecutionPlacementEvidence({
      runId: RAW_RUN_ID,
      observedAt: OBSERVED_AT,
      result,
    });
    const tampered = { ...evidence, observedAt: '2026-07-19T15:00:02.000Z' };

    expect(verifyExecutionPlacementEvidenceDigest(tampered)).toBe(false);
    expect(() => parseExecutionPlacementEvidence(tampered)).toThrowError(
      ExecutionPlacementEvidenceError,
    );
    expect(
      executionPlacementEvidenceSchema.safeParse({
        ...evidence,
        output: RAW_OUTPUT,
      }).success,
    ).toBe(false);

    expect(() =>
      createExecutionPlacementEvidence({
        runId: RAW_RUN_ID,
        observedAt: OBSERVED_AT,
        result: {
          ...result,
          execution: {
            ...result.execution,
            planDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
      }),
    ).toThrowError(ExecutionPlacementEvidenceCreationError);
  });
});

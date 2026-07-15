import { describe, expect, it } from 'vitest';

import { planStageGraph, PlannerError } from '../../src/application/planner.js';
import { sealCapabilitySnapshot } from '../../src/domain/snapshot.js';

const NOW = '2026-07-15T12:00:00.000Z';

function fabric() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'Fabric',
    zones: [
      { id: 'browser', trustLevel: 3, residencies: ['EU'] },
      { id: 'local', trustLevel: 2, residencies: ['EU'] },
      { id: 'cloud', trustLevel: 1, residencies: ['US'] },
    ],
    classifications: [
      { id: 'public', rank: 0, minTrustLevel: 0 },
      {
        id: 'internal',
        rank: 1,
        minTrustLevel: 2,
        allowedZones: ['browser', 'local'],
      },
      { id: 'secret', rank: 2, minTrustLevel: 3, allowedZones: ['browser'] },
    ],
    targets: [
      {
        id: 'browser-a',
        zone: 'browser',
        adapter: { kind: 'in-process' },
        capabilities: ['privacy.redact', 'privacy.declassify', 'embed'],
        expectedP95Ms: 5,
        costMicros: 0,
      },
      {
        id: 'local-b',
        zone: 'local',
        adapter: { kind: 'openai-compatible' },
        capabilities: ['embed'],
        expectedP95Ms: 8,
        costMicros: 1,
      },
      {
        id: 'cloud-c',
        zone: 'cloud',
        adapter: { kind: 'openai-compatible' },
        capabilities: ['reason'],
        expectedP95Ms: 20,
        costMicros: 10,
      },
    ],
    policy: { zonePreference: ['browser', 'local', 'cloud'], maxFallbacks: 2 },
  };
}

function snapshot(
  browserCapabilities = ['privacy.redact', 'privacy.declassify', 'embed'],
) {
  return sealCapabilitySnapshot({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshot',
    observedAt: '2026-07-15T11:00:00.000Z',
    expiresAt: '2026-07-15T13:00:00.000Z',
    targets: [
      {
        targetId: 'browser-a',
        healthy: true,
        capabilities: browserCapabilities,
      },
      { targetId: 'local-b', healthy: true, capabilities: ['embed'] },
      { targetId: 'cloud-c', healthy: true, capabilities: ['reason'] },
    ],
  });
}

function graph() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'StageGraph',
    metadata: { name: 'privacy-first-embedding' },
    inputs: [
      {
        name: 'text',
        type: 'text/plain',
        classification: 'secret',
        residencies: ['EU'],
        origin: { zone: 'browser', targetId: 'browser-a' },
      },
    ],
    stages: [
      {
        id: 'redact',
        operation: 'redact',
        inputs: { text: { ref: 'input.text', type: 'text/plain' } },
        outputs: [
          { name: 'safe', type: 'text/plain', classification: 'internal' },
        ],
        requirements: { capabilities: ['privacy.redact'] },
        declassifications: [
          {
            output: 'safe',
            toClassification: 'internal',
            authorityCapability: 'privacy.declassify',
            justification: 'verified removal of direct identifiers',
          },
        ],
      },
      {
        id: 'embed',
        operation: 'embed',
        inputs: { text: { ref: 'redact.safe', type: 'text/plain' } },
        outputs: [
          { name: 'vector', type: 'vector/f32', classification: 'internal' },
        ],
        requirements: { capabilities: ['embed'] },
      },
    ],
  };
}

function codeFrom(action: () => unknown): PlannerError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PlannerError);
    return error as PlannerError;
  }
  throw new Error('expected planner to fail');
}

describe('planStageGraph', () => {
  it('is deterministic under non-semantic permutations and proves fallback egress', () => {
    const first = planStageGraph({
      fabric: fabric(),
      snapshot: snapshot(),
      graph: graph(),
      evaluatedAt: NOW,
    });
    const permutedFabric = fabric();
    permutedFabric.zones.reverse();
    permutedFabric.targets.reverse();
    permutedFabric.classifications.reverse();
    const permutedGraph = graph();
    permutedGraph.stages.reverse();
    const snapshotContent = snapshot();
    const { digest: _digest, ...content } = snapshotContent;
    content.targets.reverse();
    const second = planStageGraph({
      fabric: permutedFabric,
      snapshot: sealCapabilitySnapshot(content),
      graph: permutedGraph,
      evaluatedAt: NOW,
    });

    expect(second.digest).toBe(first.digest);
    expect(first.stages.map((stage) => stage.stageId)).toEqual([
      'redact',
      'embed',
    ]);
    expect(first.stages[1]!.primary.targetId).toBe('browser-a');
    expect(first.stages[1]!.fallbacks[0]!.targetId).toBe('local-b');
    expect(first.egress.proofs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transfer: 'cross-zone',
          classification: 'internal',
          reasons: expect.arrayContaining([
            { code: 'explicit_declassification_applied' },
          ]),
        }),
      ]),
    );
  });

  it('detects missing references and cycles', () => {
    const missing = graph();
    missing.stages[1]!.inputs.text.ref = 'ghost.value';
    expect(
      codeFrom(() =>
        planStageGraph({
          fabric: fabric(),
          snapshot: snapshot(),
          graph: missing,
          evaluatedAt: NOW,
        }),
      ).code,
    ).toBe('missing_reference');

    const cyclic = graph();
    cyclic.stages[0]!.inputs.text = { ref: 'embed.vector', type: 'vector/f32' };
    expect(
      codeFrom(() =>
        planStageGraph({
          fabric: fabric(),
          snapshot: snapshot(),
          graph: cyclic,
          evaluatedAt: NOW,
        }),
      ).code,
    ).toBe('cycle_detected');
  });

  it('requires an explicit, capability-authorized declassification', () => {
    const undeclared = graph();
    undeclared.stages[0]!.declassifications = [];
    expect(
      codeFrom(() =>
        planStageGraph({
          fabric: fabric(),
          snapshot: snapshot(),
          graph: undeclared,
          evaluatedAt: NOW,
        }),
      ).code,
    ).toBe('declassification_required');

    const unauthorized = snapshot(['privacy.redact', 'embed']);
    const error = codeFrom(() =>
      planStageGraph({
        fabric: fabric(),
        snapshot: unauthorized,
        graph: graph(),
        evaluatedAt: NOW,
      }),
    );
    expect(error.code).toBe('no_eligible_target');
    expect(error.details).toMatchObject({
      stageId: 'redact',
      rejected: expect.arrayContaining([
        expect.objectContaining({
          targetId: 'browser-a',
          reasons: expect.arrayContaining([
            { code: 'capability_unavailable', values: ['privacy.declassify'] },
          ]),
        }),
      ]),
    });
  });

  it('changes placement when an observed capability disappears', () => {
    const browserPlan = planStageGraph({
      fabric: fabric(),
      snapshot: snapshot(),
      graph: graph(),
      evaluatedAt: NOW,
    });
    const localPlan = planStageGraph({
      fabric: fabric(),
      snapshot: snapshot(['privacy.redact', 'privacy.declassify']),
      graph: graph(),
      evaluatedAt: NOW,
    });

    expect(
      browserPlan.stages.find((stage) => stage.stageId === 'embed')!.primary
        .targetId,
    ).toBe('browser-a');
    expect(
      localPlan.stages.find((stage) => stage.stageId === 'embed')!.primary
        .targetId,
    ).toBe('local-b');
  });
});

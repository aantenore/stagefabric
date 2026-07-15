import { describe, expect, it } from 'vitest';

import {
  capabilitySnapshotSchema,
  fabricSchema,
  stageGraphSchema,
} from '../../src/domain/schema.js';

describe('strict StageFabric schemas', () => {
  it('rejects unknown fields and duplicate fabric identifiers', () => {
    const base = {
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'Fabric',
      zones: [{ id: 'local', trustLevel: 2 }],
      classifications: [{ id: 'internal', rank: 1 }],
      targets: [
        {
          id: 'target-a',
          zone: 'local',
          adapter: { kind: 'in-process' },
          capabilities: ['embed'],
          expectedP95Ms: 1,
          costMicros: 0,
        },
      ],
    };
    expect(fabricSchema.safeParse({ ...base, unexpected: true }).success).toBe(
      false,
    );
    expect(
      fabricSchema.safeParse({ ...base, zones: [...base.zones, ...base.zones] })
        .success,
    ).toBe(false);
  });

  it('requires canonical snapshot digests and exact graph shapes', () => {
    expect(
      capabilitySnapshotSchema.safeParse({
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'CapabilitySnapshot',
        observedAt: '2026-07-15T11:00:00.000Z',
        expiresAt: '2026-07-15T12:00:00.000Z',
        targets: [],
        digest: 'not-a-digest',
      }).success,
    ).toBe(false);
    expect(
      stageGraphSchema.safeParse({
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'StageGraph',
        metadata: { name: 'strict' },
        stages: [
          {
            id: 'stage',
            operation: 'noop',
            inputs: {},
            outputs: [
              {
                name: 'value',
                type: 'application/json',
                classification: 'public',
                extra: true,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

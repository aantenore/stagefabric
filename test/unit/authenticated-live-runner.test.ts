import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticateCapabilitySnapshotError,
  authenticateCapabilitySnapshot,
} from '../../src/application/authenticate-capability-snapshot.js';
import {
  AuthenticatedLiveRunnerError,
  planAuthenticatedLiveStageGraph,
  runAuthenticatedLiveStageGraph,
} from '../../src/composition/authenticated-live-runner.js';
import {
  capabilitySnapshotChallengeReceiptSchema,
  capabilitySnapshotTrustPolicySchema,
  computeCapabilitySnapshotFabricDigest,
  createCapabilitySnapshotAttestationStatement,
} from '../../src/domain/capability-snapshot-attestation.js';
import { sealRuntimeBindings } from '../../src/domain/runtime-bindings.js';
import {
  computeRuntimeQualificationProfileDigest,
  sealRuntimeQualificationReport,
} from '../../src/domain/runtime-qualification.js';
import { sealCapabilitySnapshot } from '../../src/domain/snapshot.js';
import {
  IN_TOTO_STATEMENT_PAYLOAD_TYPE,
  type CapabilitySnapshotAttestationVerifier,
  type VerifiedAttestationSigner,
} from '../../src/ports/capability-snapshot-attestation-verifier.js';
import type { CapabilitySnapshotChallengeConsumer } from '../../src/ports/capability-snapshot-challenge-consumer.js';

const SIGNER = Object.freeze({
  issuer: 'https://token.actions.githubusercontent.com',
  identityType: 'uri',
  identity:
    'https://github.com/aantenore/stagefabric/.github/workflows/release.yml@refs/heads/main',
} satisfies VerifiedAttestationSigner);

const graph = {
  apiVersion: 'stagefabric.dev/v1alpha1',
  kind: 'StageGraph',
  metadata: { name: 'authenticated-summary', labels: {} },
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

function fabric() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1' as const,
    kind: 'Fabric' as const,
    zones: [
      {
        id: 'edge',
        trustLevel: 1,
        residencies: ['EU'],
        labels: {},
      },
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
        id: 'edge-a',
        zone: 'edge',
        adapter: { kind: 'openai-compatible' as const },
        capabilities: ['text-generation'],
        expectedP95Ms: 10,
        costMicros: 1,
        labels: {},
      },
    ],
    policy: { zonePreference: ['edge'], maxFallbacks: 0 },
  };
}

function bindings() {
  return sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 1_000,
      maxResponseBytes: 16_384,
      snapshotTtlSeconds: 120,
    },
    targets: [
      {
        targetId: 'edge-a',
        provider: {
          kind: 'openai-compatible',
          name: 'edge-runtime',
          baseUrl: 'https://edge-a.invalid/v1',
          apiKeyEnv: 'STAGEFABRIC_EDGE_API_KEY',
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'summarize',
            capabilities: ['text-generation'],
            model: 'summary-live',
            input: 'prompt',
            output: 'answer',
            maxOutputTokens: 64,
          },
        ],
      },
    ],
  });
}

function qualificationProfile() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1' as const,
    kind: 'RuntimeQualificationProfile' as const,
    limits: {
      totalTimeoutMs: 2_000,
      maxConcurrency: 1,
      maxTargets: 1,
      maxOperations: 1,
      maxGenerationOutputTokensPerCall: 64,
    },
    targets: [{ targetId: 'edge-a', operations: ['summarize'] }],
  };
}

function snapshot(
  runtimeBindings: ReturnType<typeof bindings>,
  observedAt = '2026-07-17T10:00:10.000Z',
  targetExpiresAt?: string,
) {
  return sealCapabilitySnapshot({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshot',
    bindingDigest: runtimeBindings.digest,
    observedAt,
    expiresAt: '2026-07-17T10:02:10.000Z',
    targets: [
      {
        targetId: 'edge-a',
        healthy: true,
        capabilities: ['text-generation', 'stagefabric.operation/summarize'],
        ...(targetExpiresAt === undefined
          ? {}
          : { observedAt, expiresAt: targetExpiresAt }),
      },
    ],
  });
}

function fixture(
  observedAt = '2026-07-17T10:00:10.000Z',
  targetExpiresAt?: string,
) {
  const runtimeFabric = fabric();
  const runtimeBindings = bindings();
  const profile = qualificationProfile();
  const capabilitySnapshot = snapshot(
    runtimeBindings,
    observedAt,
    targetExpiresAt,
  );
  const qualificationReport = sealRuntimeQualificationReport({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeQualificationReport',
    bindingDigest: runtimeBindings.digest,
    profileDigest: computeRuntimeQualificationProfileDigest(profile),
    qualificationScope: 'configured-wire-shape-v1',
    producer: { id: 'stagefabric-runtime-qualification', version: '1' },
    qualified: true,
    results: [
      {
        targetId: 'edge-a',
        operation: 'summarize',
        operationKind: 'generate-text',
        status: 'qualified',
        reasonCode: 'qualified',
        qualifier: { kind: 'openai-compatible', version: 'test-v1' },
      },
    ],
  });
  const trustPolicy = capabilitySnapshotTrustPolicySchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshotTrustPolicy',
    certificateIssuer: SIGNER.issuer,
    signerIdentity: { type: SIGNER.identityType, value: SIGNER.identity },
    audience: 'stagefabric:test-control-plane',
    certificateThreshold: 1,
    transparencyLogThreshold: 1,
    fabricDigest: computeCapabilitySnapshotFabricDigest(runtimeFabric),
    qualificationProfileDigest:
      computeRuntimeQualificationProfileDigest(profile),
    maxSnapshotAgeSeconds: 180,
    maxSnapshotTtlSeconds: 180,
    clockSkewSeconds: 5,
  });
  const expectedChallenge = capabilitySnapshotChallengeReceiptSchema.parse({
    value: 'A'.repeat(43),
    audience: trustPolicy.audience,
    issuedAt: '2026-07-17T10:00:00.000Z',
    expiresAt: '2026-07-17T10:04:00.000Z',
  });
  const evidence = {
    fabric: runtimeFabric,
    snapshot: capabilitySnapshot,
    bindings: runtimeBindings,
    qualificationReport,
    qualificationProfile: profile,
    trustPolicy,
    expectedChallenge,
  };
  const statement = createCapabilitySnapshotAttestationStatement({
    ...evidence,
    challenge: expectedChallenge,
  });
  return { ...evidence, statement };
}

function statementPayload(statement: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(statement));
}

function verifierReturning(
  payload: Uint8Array,
  signer: VerifiedAttestationSigner = SIGNER,
): CapabilitySnapshotAttestationVerifier {
  return {
    verify: vi.fn(async () => ({
      payloadType: IN_TOTO_STATEMENT_PAYLOAD_TYPE,
      payload,
      signer,
    })),
  };
}

function authenticationRequest(
  inputs: ReturnType<typeof fixture>,
  evaluatedAt: string,
) {
  return {
    bundle: new Uint8Array([1, 2, 3]),
    fabric: inputs.fabric,
    snapshot: inputs.snapshot,
    bindings: inputs.bindings,
    qualificationReport: inputs.qualificationReport,
    qualificationProfile: inputs.qualificationProfile,
    trustPolicy: inputs.trustPolicy,
    expectedChallenge: inputs.expectedChallenge,
    evaluatedAt,
  };
}

describe('authenticated capability snapshot application service', () => {
  it('derives the same authorization digest at different verification times', async () => {
    const inputs = fixture();
    const verifier = verifierReturning(statementPayload(inputs.statement));

    const first = await authenticateCapabilitySnapshot(
      authenticationRequest(inputs, '2026-07-17T10:00:20.000Z'),
      verifier,
    );
    const second = await authenticateCapabilitySnapshot(
      authenticationRequest(inputs, '2026-07-17T10:00:21.000Z'),
      verifier,
    );

    expect(first.evidence.verifiedAt).not.toBe(second.evidence.verifiedAt);
    expect(first.authorizationDigest).toBe(second.authorizationDigest);
    expect(first.signer).toEqual(SIGNER);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });

  it('does not parse an unauthenticated payload when envelope verification fails', async () => {
    const inputs = fixture();
    const verifier: CapabilitySnapshotAttestationVerifier = {
      verify: vi.fn(async () => {
        throw new Error('sensitive verifier detail');
      }),
    };

    const failure = authenticateCapabilitySnapshot(
      {
        ...authenticationRequest(inputs, '2026-07-17T10:00:20.000Z'),
        bundle: new TextEncoder().encode('{not-json'),
      },
      verifier,
    );

    await expect(failure).rejects.toEqual(
      expect.objectContaining<Partial<AuthenticateCapabilitySnapshotError>>({
        code: 'verification_failed',
      }),
    );
    await expect(failure).rejects.not.toThrow('sensitive verifier detail');
  });

  it('fails closed when the verified signer differs from policy', async () => {
    const inputs = fixture();
    const verifier = verifierReturning(statementPayload(inputs.statement), {
      ...SIGNER,
      identity: 'https://github.com/example/other-workflow',
    });

    await expect(
      authenticateCapabilitySnapshot(
        authenticationRequest(inputs, '2026-07-17T10:00:20.000Z'),
        verifier,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AuthenticateCapabilitySnapshotError>>({
        code: 'signer_mismatch',
      }),
    );
  });

  it('samples a lazy verification clock only after envelope verification', async () => {
    const inputs = fixture();
    const events: string[] = [];
    const verifier: CapabilitySnapshotAttestationVerifier = {
      verify: vi.fn(async () => {
        events.push('verify');
        return {
          payloadType: IN_TOTO_STATEMENT_PAYLOAD_TYPE,
          payload: statementPayload(inputs.statement),
          signer: SIGNER,
        };
      }),
    };

    const result = await authenticateCapabilitySnapshot(
      {
        ...authenticationRequest(inputs, 'unused'),
        evaluatedAt: () => {
          events.push('clock');
          return '2026-07-17T10:00:20.000Z';
        },
      },
      verifier,
    );

    expect(events).toEqual(['verify', 'clock']);
    expect(result.evidence.verifiedAt).toBe('2026-07-17T10:00:20.000Z');
  });
});

describe('authenticated live runner', () => {
  it('plans from one canonical snapshot copy without consuming or provider I/O', async () => {
    const first = fixture('2026-07-17T10:00:10.000Z');
    const second = fixture('2026-07-17T10:00:11.000Z');
    let snapshotReads = 0;
    const verifier = verifierReturning(statementPayload(first.statement));
    const request = {
      attestationBundle: new Uint8Array([1, 2, 3]),
      fabric: first.fabric,
      graph,
      bindings: first.bindings,
      inputs: { prompt: 'read-only plan input' },
      get snapshot() {
        snapshotReads += 1;
        return snapshotReads === 1 ? first.snapshot : second.snapshot;
      },
      qualificationReport: first.qualificationReport,
      qualificationProfile: first.qualificationProfile,
      trustPolicy: first.trustPolicy,
      expectedChallenge: first.expectedChallenge,
    };

    const result = await planAuthenticatedLiveStageGraph(request, {
      verifier,
      now: () => new Date('2026-07-17T10:00:20.000Z'),
    });

    expect(snapshotReads).toBe(1);
    expect(result.plan.snapshotDigest).toBe(first.snapshot.digest);
    expect(result.trust.evidence.snapshotDigest).toBe(first.snapshot.digest);
    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it('verifies twice, consumes once, and only then reaches the provider', async () => {
    const inputs = fixture();
    const events: string[] = [];
    let verificationCount = 0;
    const verifier: CapabilitySnapshotAttestationVerifier = {
      verify: vi.fn(async () => {
        verificationCount += 1;
        events.push(`verify:${verificationCount}`);
        return {
          payloadType: IN_TOTO_STATEMENT_PAYLOAD_TYPE,
          payload: statementPayload(inputs.statement),
          signer: SIGNER,
        };
      }),
    };
    const consumer: CapabilitySnapshotChallengeConsumer = {
      consume: vi.fn(async () => {
        events.push('consume');
        return true;
      }),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      events.push('provider');
      return Response.json({
        choices: [
          {
            message: { role: 'assistant', content: 'Authenticated answer.' },
            finish_reason: 'stop',
          },
        ],
      });
    });
    const clockValues = [
      new Date('2026-07-17T10:00:20.000Z'),
      new Date('2026-07-17T10:00:21.000Z'),
    ];
    const environment = {
      get STAGEFABRIC_EDGE_API_KEY() {
        events.push('credential');
        return 'secret-token';
      },
    };

    const result = await runAuthenticatedLiveStageGraph(
      {
        attestationBundle: new Uint8Array([1, 2, 3]),
        fabric: inputs.fabric,
        graph,
        bindings: inputs.bindings,
        inputs: { prompt: 'sensitive user input' },
        snapshot: inputs.snapshot,
        qualificationReport: inputs.qualificationReport,
        qualificationProfile: inputs.qualificationProfile,
        trustPolicy: inputs.trustPolicy,
        expectedChallenge: inputs.expectedChallenge,
      },
      {
        verifier,
        challengeConsumer: consumer,
        now: () => clockValues.shift()!,
        environment,
        fetch,
      },
    );

    expect(events).toEqual([
      'verify:1',
      'verify:2',
      'consume',
      'credential',
      'provider',
    ]);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(consumer.consume).toHaveBeenCalledTimes(1);
    expect(result.trust.evidence.verifiedAt).toBe('2026-07-17T10:00:21.000Z');
    expect(result.outputs).toEqual({
      'summarize.answer': 'Authenticated answer.',
    });
    expect(JSON.stringify(result.trust)).not.toContain('sensitive user input');
    expect(JSON.stringify(result.trust)).not.toContain('secret-token');
  });

  it('rejects a replay before provider or credential work', async () => {
    const inputs = fixture();
    const verifier = verifierReturning(statementPayload(inputs.statement));
    const consumer: CapabilitySnapshotChallengeConsumer = {
      consume: vi.fn(async () => false),
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const clockValues = [
      new Date('2026-07-17T10:00:20.000Z'),
      new Date('2026-07-17T10:00:21.000Z'),
    ];
    let credentialReads = 0;
    const environment = {
      get STAGEFABRIC_EDGE_API_KEY() {
        credentialReads += 1;
        return 'must-not-be-read';
      },
    };

    await expect(
      runAuthenticatedLiveStageGraph(
        {
          attestationBundle: new Uint8Array([1, 2, 3]),
          fabric: inputs.fabric,
          graph,
          bindings: inputs.bindings,
          inputs: { prompt: 'must not leave process' },
          snapshot: inputs.snapshot,
          qualificationReport: inputs.qualificationReport,
          qualificationProfile: inputs.qualificationProfile,
          trustPolicy: inputs.trustPolicy,
          expectedChallenge: inputs.expectedChallenge,
        },
        {
          verifier,
          challengeConsumer: consumer,
          now: () => clockValues.shift()!,
          environment,
          fetch,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AuthenticatedLiveRunnerError>>({
        code: 'challenge_already_consumed',
      }),
    );
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(consumer.consume).toHaveBeenCalledTimes(1);
    expect(credentialReads).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replans after the second verification and rejects a newly expired target', async () => {
    const inputs = fixture(
      '2026-07-17T10:00:10.000Z',
      '2026-07-17T10:00:21.000Z',
    );
    const verifier = verifierReturning(statementPayload(inputs.statement));
    const consumer: CapabilitySnapshotChallengeConsumer = {
      consume: vi.fn(async () => true),
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const clockValues = [
      new Date('2026-07-17T10:00:20.000Z'),
      new Date('2026-07-17T10:00:22.000Z'),
    ];

    await expect(
      runAuthenticatedLiveStageGraph(
        {
          attestationBundle: new Uint8Array([1, 2, 3]),
          fabric: inputs.fabric,
          graph,
          bindings: inputs.bindings,
          inputs: { prompt: 'must not execute after target expiry' },
          snapshot: inputs.snapshot,
          qualificationReport: inputs.qualificationReport,
          qualificationProfile: inputs.qualificationProfile,
          trustPolicy: inputs.trustPolicy,
          expectedChallenge: inputs.expectedChallenge,
        },
        {
          verifier,
          challengeConsumer: consumer,
          now: () => clockValues.shift()!,
          environment: { STAGEFABRIC_EDGE_API_KEY: 'must-not-be-read' },
          fetch,
        },
      ),
    ).rejects.toMatchObject({ code: 'no_eligible_target' });
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(consumer.consume).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('snapshots a time-varying getter once for both verification passes and planning', async () => {
    const first = fixture('2026-07-17T10:00:10.000Z');
    const second = fixture('2026-07-17T10:00:11.000Z');
    let snapshotReads = 0;
    const verifier = verifierReturning(statementPayload(first.statement));
    const consumer: CapabilitySnapshotChallengeConsumer = {
      consume: vi.fn(async () => true),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        choices: [
          {
            message: { role: 'assistant', content: 'Canonical answer.' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const request = {
      attestationBundle: new Uint8Array([1, 2, 3]),
      fabric: first.fabric,
      graph,
      bindings: first.bindings,
      inputs: { prompt: 'must not execute' },
      get snapshot() {
        snapshotReads += 1;
        return snapshotReads === 1 ? first.snapshot : second.snapshot;
      },
      qualificationReport: first.qualificationReport,
      qualificationProfile: first.qualificationProfile,
      trustPolicy: first.trustPolicy,
      expectedChallenge: first.expectedChallenge,
    };
    const clockValues = [
      new Date('2026-07-17T10:00:20.000Z'),
      new Date('2026-07-17T10:00:21.000Z'),
    ];

    const result = await runAuthenticatedLiveStageGraph(request, {
      verifier,
      challengeConsumer: consumer,
      now: () => clockValues.shift()!,
      environment: { STAGEFABRIC_EDGE_API_KEY: 'token' },
      fetch,
    });

    expect(snapshotReads).toBe(1);
    expect(result.plan.snapshotDigest).toBe(first.snapshot.digest);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(consumer.consume).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

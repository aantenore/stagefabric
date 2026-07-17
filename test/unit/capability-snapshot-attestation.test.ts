import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_SNAPSHOT_AUTHORITY,
  CAPABILITY_SNAPSHOT_PREDICATE_TYPE,
  CAPABILITY_SNAPSHOT_STATEMENT_TYPE,
  CAPABILITY_SNAPSHOT_SUBJECTS,
  CapabilitySnapshotAttestationError,
  capabilitySnapshotAttestationStatementSchema,
  capabilitySnapshotChallengeReceiptSchema,
  capabilitySnapshotTrustPolicySchema,
  computeCapabilitySnapshotChallengeDigest,
  computeCapabilitySnapshotFabricDigest,
  computeCapabilitySnapshotTargetScopeDigest,
  computeCapabilitySnapshotTrustPolicyDigest,
  createCapabilitySnapshotAttestationStatement,
  parseCapabilitySnapshotAttestationStatement,
  verifyCapabilitySnapshotAttestationSemantics,
  type CapabilitySnapshotAttestationErrorCode,
} from '../../src/domain/capability-snapshot-attestation.js';
import { canonicalJson } from '../../src/domain/canonical.js';
import {
  sealRuntimeBindings,
  verifyRuntimeBindingsDigest,
} from '../../src/domain/runtime-bindings.js';
import {
  computeRuntimeQualificationProfileDigest,
  sealRuntimeQualificationReport,
} from '../../src/domain/runtime-qualification.js';
import { sealCapabilitySnapshot } from '../../src/domain/snapshot.js';

const CHALLENGE_VALUE = 'A'.repeat(43);
const OTHER_CHALLENGE_VALUE = `${'B'.repeat(42)}A`;

function fabric() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1' as const,
    kind: 'Fabric' as const,
    zones: [{ id: 'edge', trustLevel: 2, residencies: ['EU'] }],
    classifications: [{ id: 'internal', rank: 1, minTrustLevel: 2 }],
    targets: [
      {
        id: 'edge-a',
        zone: 'edge',
        adapter: { kind: 'openai-compatible' },
        capabilities: ['text-generation', 'embedding'],
        expectedP95Ms: 10,
        costMicros: 1,
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
          baseUrl: 'https://edge.invalid/v1',
          apiKeyEnv: 'STAGEFABRIC_EDGE_API_KEY',
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'generate',
            capabilities: ['text-generation'],
            model: 'model-7b',
            input: 'prompt',
            output: 'text',
            systemPrompt: 'Do not disclose fixture data.',
            maxOutputTokens: 64,
          },
          {
            kind: 'embedding',
            operation: 'embed',
            capabilities: ['embedding'],
            model: 'embed-v1',
            input: 'text',
            output: 'vector',
            expectedDimensions: 3,
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
      maxOperations: 2,
      maxGenerationOutputTokensPerCall: 64,
    },
    targets: [{ targetId: 'edge-a', operations: ['generate', 'embed'] }],
  };
}

function snapshot(runtimeBindings = bindings()) {
  return sealCapabilitySnapshot({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshot',
    bindingDigest: runtimeBindings.digest,
    observedAt: '2026-07-17T10:00:10.000Z',
    expiresAt: '2026-07-17T10:02:10.000Z',
    targets: [
      {
        targetId: 'edge-a',
        healthy: true,
        capabilities: [
          'text-generation',
          'embedding',
          'stagefabric.operation/generate',
          'stagefabric.operation/embed',
        ],
      },
    ],
  });
}

function qualificationReport(
  runtimeBindings = bindings(),
  profile = qualificationProfile(),
) {
  return sealRuntimeQualificationReport({
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
        operation: 'generate',
        operationKind: 'generate-text',
        status: 'qualified',
        reasonCode: 'qualified',
        qualifier: { kind: 'openai-compatible', version: 'test-v1' },
      },
      {
        targetId: 'edge-a',
        operation: 'embed',
        operationKind: 'embedding',
        status: 'qualified',
        reasonCode: 'qualified',
        qualifier: { kind: 'openai-compatible', version: 'test-v1' },
      },
    ],
  });
}

function trustPolicy(
  profile = qualificationProfile(),
  overrides: Record<string, unknown> = {},
) {
  return capabilitySnapshotTrustPolicySchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshotTrustPolicy',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    signerIdentity: {
      type: 'uri',
      value:
        'https://github.com/aantenore/stagefabric/.github/workflows/release.yml@refs/heads/main',
    },
    audience: 'stagefabric:test-control-plane',
    certificateThreshold: 1,
    transparencyLogThreshold: 1,
    fabricDigest: computeCapabilitySnapshotFabricDigest(fabric()),
    qualificationProfileDigest:
      computeRuntimeQualificationProfileDigest(profile),
    maxSnapshotAgeSeconds: 180,
    maxSnapshotTtlSeconds: 180,
    clockSkewSeconds: 5,
    ...overrides,
  });
}

function challenge(overrides: Record<string, unknown> = {}) {
  return capabilitySnapshotChallengeReceiptSchema.parse({
    value: CHALLENGE_VALUE,
    audience: 'stagefabric:test-control-plane',
    issuedAt: '2026-07-17T10:00:00.000Z',
    expiresAt: '2026-07-17T10:04:00.000Z',
    ...overrides,
  });
}

function fixture(policyOverrides: Record<string, unknown> = {}) {
  const runtimeBindings = bindings();
  const profile = qualificationProfile();
  const capabilitySnapshot = snapshot(runtimeBindings);
  const report = qualificationReport(runtimeBindings, profile);
  const policy = trustPolicy(profile, policyOverrides);
  const receipt = challenge();
  return {
    fabric: fabric(),
    snapshot: capabilitySnapshot,
    bindings: runtimeBindings,
    qualificationReport: report,
    qualificationProfile: profile,
    trustPolicy: policy,
    challenge: receipt,
  };
}

function expectCode(
  action: () => unknown,
  code: CapabilitySnapshotAttestationErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilitySnapshotAttestationError);
    expect((error as CapabilitySnapshotAttestationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('capability snapshot attestation contracts', () => {
  it('creates the exact content-subject in-toto statement without raw evidence', () => {
    const inputs = fixture();
    const statement = createCapabilitySnapshotAttestationStatement(inputs);

    expect(statement).toEqual({
      _type: CAPABILITY_SNAPSHOT_STATEMENT_TYPE,
      subject: [
        {
          name: CAPABILITY_SNAPSHOT_SUBJECTS.snapshot,
          digest: { sha256: inputs.snapshot.digest.slice('sha256:'.length) },
        },
        {
          name: CAPABILITY_SNAPSHOT_SUBJECTS.bindings,
          digest: { sha256: inputs.bindings.digest.slice('sha256:'.length) },
        },
        {
          name: CAPABILITY_SNAPSHOT_SUBJECTS.qualificationReport,
          digest: {
            sha256: inputs.qualificationReport.digest.slice('sha256:'.length),
          },
        },
      ],
      predicateType: CAPABILITY_SNAPSHOT_PREDICATE_TYPE,
      predicate: {
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'CapabilitySnapshotAttestation',
        audience: inputs.trustPolicy.audience,
        authority: CAPABILITY_SNAPSHOT_AUTHORITY,
        fabricDigest: inputs.trustPolicy.fabricDigest,
        qualificationProfileDigest:
          inputs.trustPolicy.qualificationProfileDigest,
        trustPolicyDigest: computeCapabilitySnapshotTrustPolicyDigest(
          inputs.trustPolicy,
        ),
        targetScopeDigest: computeCapabilitySnapshotTargetScopeDigest(
          inputs.snapshot,
        ),
        challengeDigest:
          computeCapabilitySnapshotChallengeDigest(CHALLENGE_VALUE),
        challengeIssuedAt: inputs.challenge.issuedAt,
        challengeExpiresAt: inputs.challenge.expiresAt,
        observedAt: inputs.snapshot.observedAt,
        expiresAt: inputs.snapshot.expiresAt,
      },
    });
    expect(canonicalJson(statement)).not.toContain(CHALLENGE_VALUE);
    expect(canonicalJson(statement)).not.toContain('edge.invalid');
    expect(canonicalJson(statement)).not.toContain('model-7b');
    expect(canonicalJson(statement)).not.toContain('fixture data');
  });

  it('keeps trust and challenge configuration strict, literal and bounded', () => {
    const policy = trustPolicy();
    expect(computeCapabilitySnapshotChallengeDigest(CHALLENGE_VALUE)).toBe(
      'sha256:66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
    );
    for (const candidate of [
      { ...policy, certificateThreshold: 0 },
      { ...policy, transparencyLogThreshold: 0 },
      { ...policy, identityRegex: '.*' },
      { ...policy, module: './trust-root.js' },
      {
        ...policy,
        signerIdentity: { type: 'regex', value: '.*aantenore.*' },
      },
    ]) {
      expect(
        capabilitySnapshotTrustPolicySchema.safeParse(candidate).success,
      ).toBe(false);
    }

    expect(
      capabilitySnapshotChallengeReceiptSchema.safeParse({
        ...challenge(),
        value: 'A'.repeat(42),
      }).success,
    ).toBe(false);
    expect(
      capabilitySnapshotChallengeReceiptSchema.safeParse({
        ...challenge(),
        value: `${'A'.repeat(42)}B`,
      }).success,
    ).toBe(false);
    expect(
      capabilitySnapshotChallengeReceiptSchema.safeParse({
        ...challenge(),
        expiresAt: challenge().issuedAt,
      }).success,
    ).toBe(false);
  });

  it('accepts in-toto extension fields but keeps predicate and subjects strict', () => {
    const statement = createCapabilitySnapshotAttestationStatement(fixture());
    expect(
      parseCapabilitySnapshotAttestationStatement({
        ...statement,
        extension: { producer: 'external-signer' },
      }),
    ).not.toHaveProperty('extension');
    expect(
      capabilitySnapshotAttestationStatementSchema.safeParse({
        ...statement,
        predicate: { ...statement.predicate, extraAuthority: true },
      }).success,
    ).toBe(false);
    expect(
      capabilitySnapshotAttestationStatementSchema.safeParse({
        ...statement,
        subject: [
          { ...statement.subject[0], endpoint: 'https://edge.invalid' },
          statement.subject[1],
          statement.subject[2],
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unsealed or mutated snapshots and bindings', () => {
    const inputs = fixture();
    const { digest: _digest, ...unsealed } = inputs.snapshot;
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          snapshot: unsealed,
        }),
      'invalid_input',
    );

    const mutatedSnapshot = structuredClone(inputs.snapshot);
    mutatedSnapshot.targets[0]!.healthy = false;
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          snapshot: mutatedSnapshot,
        }),
      'snapshot_digest_mismatch',
    );

    const mutatedBindings = structuredClone(inputs.bindings);
    mutatedBindings.policy.snapshotTtlSeconds += 1;
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          bindings: mutatedBindings,
        }),
      'bindings_digest_mismatch',
    );
  });

  it('requires a qualified, digest-valid and binding-matched report', () => {
    const inputs = fixture();
    const mutatedReport = structuredClone(inputs.qualificationReport);
    mutatedReport.results[0]!.qualifier!.version = 'mutated';
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          qualificationReport: mutatedReport,
        }),
      'qualification_report_digest_mismatch',
    );

    const rejected = sealRuntimeQualificationReport({
      ...Object.fromEntries(
        Object.entries(inputs.qualificationReport).filter(
          ([key]) =>
            key !== 'digest' && key !== 'qualified' && key !== 'results',
        ),
      ),
      qualified: false,
      results: inputs.qualificationReport.results.map((result, index) =>
        index === 0
          ? {
              ...result,
              status: 'rejected',
              reasonCode: 'provider_rejected',
            }
          : result,
      ),
    });
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          qualificationReport: rejected,
        }),
      'qualification_required',
    );

    const otherBindings = sealRuntimeBindings({
      ...Object.fromEntries(
        Object.entries(inputs.bindings).filter(([key]) => key !== 'digest'),
      ),
      policy: { ...inputs.bindings.policy, snapshotTtlSeconds: 121 },
    });
    expect(verifyRuntimeBindingsDigest(otherBindings)).toBe(true);
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          bindings: otherBindings,
        }),
      'snapshot_binding_mismatch',
    );
  });

  it('requires exact snapshot, profile and report operation coverage', () => {
    const inputs = fixture();
    const { digest: _digest, ...content } = inputs.snapshot;
    const missingOperation = sealCapabilitySnapshot({
      ...content,
      targets: content.targets.map((target) => ({
        ...target,
        capabilities: target.capabilities.filter(
          (capability) => capability !== 'stagefabric.operation/embed',
        ),
      })),
    });
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          snapshot: missingOperation,
        }),
      'target_scope_mismatch',
    );

    const surplusOperation = sealCapabilitySnapshot({
      ...content,
      targets: content.targets.map((target) => ({
        ...target,
        capabilities: [...target.capabilities, 'stagefabric.operation/surplus'],
      })),
    });
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          snapshot: surplusOperation,
        }),
      'target_scope_mismatch',
    );

    const missingReportResult = sealRuntimeQualificationReport({
      ...Object.fromEntries(
        Object.entries(inputs.qualificationReport).filter(
          ([key]) => key !== 'digest' && key !== 'results',
        ),
      ),
      results: inputs.qualificationReport.results.slice(0, 1),
    });
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          qualificationReport: missingReportResult,
        }),
      'target_scope_mismatch',
    );

    const wrongOperationKind = sealRuntimeQualificationReport({
      ...Object.fromEntries(
        Object.entries(inputs.qualificationReport).filter(
          ([key]) => key !== 'digest' && key !== 'results',
        ),
      ),
      results: inputs.qualificationReport.results.map((result) =>
        result.operation === 'generate'
          ? { ...result, operationKind: 'embedding' }
          : result,
      ),
    });
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          qualificationReport: wrongOperationKind,
        }),
      'operation_binding_mismatch',
    );
  });

  it('returns content-free semantic evidence for the exact statement', () => {
    const inputs = fixture();
    const statement = createCapabilitySnapshotAttestationStatement(inputs);
    const evidence = verifyCapabilitySnapshotAttestationSemantics({
      statement: { ...statement, inTotoExtension: 'permitted' },
      fabric: inputs.fabric,
      snapshot: inputs.snapshot,
      bindings: inputs.bindings,
      qualificationReport: inputs.qualificationReport,
      qualificationProfile: inputs.qualificationProfile,
      trustPolicy: inputs.trustPolicy,
      expectedChallenge: inputs.challenge,
      evaluatedAt: '2026-07-17T10:01:00.000Z',
    });

    expect(evidence).toMatchObject({
      authority: 'placement-evidence-only',
      snapshotDigest: inputs.snapshot.digest,
      bindingDigest: inputs.bindings.digest,
      qualificationReportDigest: inputs.qualificationReport.digest,
      configuredSignerIdentity: inputs.trustPolicy.signerIdentity,
      verifiedAt: '2026-07-17T10:01:00.000Z',
      snapshotExpiresAt: inputs.snapshot.expiresAt,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(CHALLENGE_VALUE);
    expect(serialized).not.toContain('edge.invalid');
    expect(serialized).not.toContain('model-7b');
    expect(serialized).not.toContain('STAGEFABRIC_EDGE_API_KEY');
    expect(serialized).not.toContain('fixture data');
  });

  it('fails closed for wrong subject, audience, challenge, policy or predicate', () => {
    const inputs = fixture();
    const statement = createCapabilitySnapshotAttestationStatement(inputs);
    const verify = (candidate: unknown, expectedChallenge = inputs.challenge) =>
      verifyCapabilitySnapshotAttestationSemantics({
        statement: candidate,
        fabric: inputs.fabric,
        snapshot: inputs.snapshot,
        bindings: inputs.bindings,
        qualificationReport: inputs.qualificationReport,
        qualificationProfile: inputs.qualificationProfile,
        trustPolicy: inputs.trustPolicy,
        expectedChallenge,
        evaluatedAt: '2026-07-17T10:01:00.000Z',
      });

    const wrongSubject = structuredClone(statement);
    wrongSubject.subject[0].digest.sha256 = 'f'.repeat(64);
    expectCode(() => verify(wrongSubject), 'statement_subject_mismatch');

    expectCode(
      () =>
        verify({
          ...statement,
          predicate: { ...statement.predicate, audience: 'wrong-audience' },
        }),
      'audience_mismatch',
    );
    expectCode(
      () =>
        verify({
          ...statement,
          predicate: {
            ...statement.predicate,
            challengeDigest: `sha256:${'f'.repeat(64)}`,
          },
        }),
      'challenge_mismatch',
    );
    expectCode(
      () =>
        verify({
          ...statement,
          predicate: {
            ...statement.predicate,
            trustPolicyDigest: `sha256:${'f'.repeat(64)}`,
          },
        }),
      'trust_policy_digest_mismatch',
    );
    expectCode(
      () =>
        verify({
          ...statement,
          predicate: {
            ...statement.predicate,
            targetScopeDigest: `sha256:${'f'.repeat(64)}`,
          },
        }),
      'statement_predicate_mismatch',
    );
    expectCode(
      () =>
        verify(statement, {
          ...inputs.challenge,
          value: OTHER_CHALLENGE_VALUE,
        }),
      'challenge_mismatch',
    );
  });

  it('enforces challenge and snapshot time boundaries with clock skew', () => {
    const inputs = fixture();
    const statement = createCapabilitySnapshotAttestationStatement(inputs);
    const verifyAt = (evaluatedAt: string) =>
      verifyCapabilitySnapshotAttestationSemantics({
        statement,
        fabric: inputs.fabric,
        snapshot: inputs.snapshot,
        bindings: inputs.bindings,
        qualificationReport: inputs.qualificationReport,
        qualificationProfile: inputs.qualificationProfile,
        trustPolicy: inputs.trustPolicy,
        expectedChallenge: inputs.challenge,
        evaluatedAt,
      });

    expectCode(
      () => verifyAt('2026-07-17T09:59:54.999Z'),
      'challenge_not_yet_valid',
    );
    expectCode(
      () => verifyAt('2026-07-17T10:00:00.000Z'),
      'snapshot_from_future',
    );
    expect(verifyAt('2026-07-17T10:02:14.999Z').kind).toBe(
      'VerifiedCapabilitySnapshotEvidence',
    );
    expectCode(() => verifyAt('2026-07-17T10:02:15.000Z'), 'snapshot_expired');
    expectCode(() => verifyAt('2026-07-17T10:04:05.000Z'), 'challenge_expired');

    const oldInputs = fixture({ maxSnapshotAgeSeconds: 30 });
    const oldStatement =
      createCapabilitySnapshotAttestationStatement(oldInputs);
    expectCode(
      () =>
        verifyCapabilitySnapshotAttestationSemantics({
          statement: oldStatement,
          fabric: oldInputs.fabric,
          snapshot: oldInputs.snapshot,
          bindings: oldInputs.bindings,
          qualificationReport: oldInputs.qualificationReport,
          qualificationProfile: oldInputs.qualificationProfile,
          trustPolicy: oldInputs.trustPolicy,
          expectedChallenge: oldInputs.challenge,
          evaluatedAt: '2026-07-17T10:00:46.000Z',
        }),
      'snapshot_too_old',
    );
  });

  it('rejects overlong TTLs and observations outside the challenge receipt', () => {
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement(
          fixture({ maxSnapshotTtlSeconds: 119 }),
        ),
      'snapshot_ttl_exceeded',
    );

    const inputs = fixture();
    const { digest: _digest, ...content } = inputs.snapshot;
    const tooEarly = sealCapabilitySnapshot({
      ...content,
      observedAt: '2026-07-17T09:59:54.999Z',
    });
    expectCode(
      () =>
        createCapabilitySnapshotAttestationStatement({
          ...inputs,
          snapshot: tooEarly,
        }),
      'snapshot_outside_challenge',
    );
  });
});

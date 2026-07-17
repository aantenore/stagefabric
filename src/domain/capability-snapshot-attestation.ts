import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';

import { compareCodePointStrings, sha256Digest } from './canonical.js';
import {
  runtimeBindingsSchema,
  verifyRuntimeBindingsDigest,
  type RuntimeBindings,
} from './runtime-bindings.js';
import {
  computeRuntimeQualificationProfileDigest,
  runtimeQualificationProfileSchema,
  runtimeQualificationReportSchema,
  verifyRuntimeQualificationReportDigest,
  type RuntimeQualificationProfile,
  type RuntimeQualificationReport,
} from './runtime-qualification.js';
import {
  capabilitySnapshotSchema,
  fabricSchema,
  INTERNAL_OPERATION_CAPABILITY_PREFIX,
  sha256DigestSchema,
  STAGEFABRIC_API_VERSION,
  timestampSchema,
  type CapabilitySnapshot,
  type Fabric,
} from './schema.js';
import { verifyCapabilitySnapshotDigest } from './snapshot.js';

export const CAPABILITY_SNAPSHOT_STATEMENT_TYPE =
  'https://in-toto.io/Statement/v1' as const;
export const CAPABILITY_SNAPSHOT_PREDICATE_TYPE =
  'https://stagefabric.dev/attestations/capability-snapshot/v1' as const;
export const CAPABILITY_SNAPSHOT_AUTHORITY = 'placement-evidence-only' as const;

export const CAPABILITY_SNAPSHOT_SUBJECTS = Object.freeze({
  snapshot: 'stagefabric-capability-snapshot-content',
  bindings: 'stagefabric-runtime-bindings-content',
  qualificationReport: 'stagefabric-runtime-qualification-report-content',
} as const);

export const CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS = Object.freeze({
  certificateThreshold: { min: 1, max: 8 },
  transparencyLogThreshold: { min: 1, max: 8 },
  maxSnapshotAgeSeconds: { min: 1, max: 86_400 },
  maxSnapshotTtlSeconds: { min: 1, max: 86_400 },
  clockSkewSeconds: { min: 0, max: 300 },
} as const);

const literalStringSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => value.trim() === value,
    'must not contain edge whitespace',
  );

const httpsUrlSchema = literalStringSchema
  .refine((value) => URL.canParse(value), 'must be a valid URL')
  .refine(
    (value) => URL.canParse(value) && new URL(value).protocol === 'https:',
    'must use HTTPS',
  );

const uriSignerIdentitySchema = z
  .object({
    type: z.literal('uri'),
    value: literalStringSchema.refine(
      (value) => URL.canParse(value),
      'must be a valid URI',
    ),
  })
  .strict();

const emailSignerIdentitySchema = z
  .object({
    type: z.literal('email'),
    value: literalStringSchema.pipe(z.email()),
  })
  .strict();

export const capabilitySnapshotSignerIdentitySchema = z.discriminatedUnion(
  'type',
  [uriSignerIdentitySchema, emailSignerIdentitySchema],
);

const audienceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim() === value,
    'must not contain edge whitespace',
  );

export const capabilitySnapshotTrustPolicySchema = z
  .object({
    apiVersion: z.literal(STAGEFABRIC_API_VERSION),
    kind: z.literal('CapabilitySnapshotTrustPolicy'),
    certificateIssuer: httpsUrlSchema,
    signerIdentity: capabilitySnapshotSignerIdentitySchema,
    audience: audienceSchema,
    certificateThreshold: z
      .number()
      .int()
      .min(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.certificateThreshold.min)
      .max(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.certificateThreshold.max),
    transparencyLogThreshold: z
      .number()
      .int()
      .min(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.transparencyLogThreshold.min)
      .max(
        CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.transparencyLogThreshold.max,
      ),
    fabricDigest: sha256DigestSchema,
    qualificationProfileDigest: sha256DigestSchema,
    maxSnapshotAgeSeconds: z
      .number()
      .int()
      .min(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.maxSnapshotAgeSeconds.min)
      .max(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.maxSnapshotAgeSeconds.max),
    maxSnapshotTtlSeconds: z
      .number()
      .int()
      .min(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.maxSnapshotTtlSeconds.min)
      .max(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.maxSnapshotTtlSeconds.max),
    clockSkewSeconds: z
      .number()
      .int()
      .min(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.clockSkewSeconds.min)
      .max(CAPABILITY_SNAPSHOT_TRUST_POLICY_LIMITS.clockSkewSeconds.max),
  })
  .strict();

// A 32-byte base64url value is exactly 43 unpadded characters. Restricting the
// final character also rejects non-canonical encodings with non-zero pad bits.
export const capabilitySnapshotChallengeValueSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    'must be a canonical unpadded 256-bit base64url value',
  );

export const capabilitySnapshotChallengeReceiptSchema = z
  .object({
    value: capabilitySnapshotChallengeValueSchema,
    audience: audienceSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.issuedAt) >= Date.parse(receipt.expiresAt)) {
      context.addIssue({
        code: 'custom',
        message: 'issuedAt must be earlier than expiresAt',
        path: ['expiresAt'],
      });
    }
  });

const inTotoDigestSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

function subjectSchema<const Name extends string>(name: Name) {
  return z
    .object({ name: z.literal(name), digest: inTotoDigestSchema })
    .strict();
}

export const capabilitySnapshotAttestationPredicateSchema = z
  .object({
    apiVersion: z.literal(STAGEFABRIC_API_VERSION),
    kind: z.literal('CapabilitySnapshotAttestation'),
    audience: audienceSchema,
    authority: z.literal(CAPABILITY_SNAPSHOT_AUTHORITY),
    fabricDigest: sha256DigestSchema,
    qualificationProfileDigest: sha256DigestSchema,
    trustPolicyDigest: sha256DigestSchema,
    targetScopeDigest: sha256DigestSchema,
    challengeDigest: sha256DigestSchema,
    challengeIssuedAt: timestampSchema,
    challengeExpiresAt: timestampSchema,
    observedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export const capabilitySnapshotAttestationStatementSchema = z
  .object({
    _type: z.literal(CAPABILITY_SNAPSHOT_STATEMENT_TYPE),
    subject: z.tuple([
      subjectSchema(CAPABILITY_SNAPSHOT_SUBJECTS.snapshot),
      subjectSchema(CAPABILITY_SNAPSHOT_SUBJECTS.bindings),
      subjectSchema(CAPABILITY_SNAPSHOT_SUBJECTS.qualificationReport),
    ]),
    predicateType: z.literal(CAPABILITY_SNAPSHOT_PREDICATE_TYPE),
    predicate: capabilitySnapshotAttestationPredicateSchema,
  })
  // in-toto Statement v1 permits extension fields. Accept and ignore them;
  // the StageFabric-owned predicate and subjects remain strict.
  .strip();

export const verifiedCapabilitySnapshotEvidenceSchema = z
  .object({
    apiVersion: z.literal(STAGEFABRIC_API_VERSION),
    kind: z.literal('VerifiedCapabilitySnapshotEvidence'),
    authority: z.literal(CAPABILITY_SNAPSHOT_AUTHORITY),
    snapshotDigest: sha256DigestSchema,
    bindingDigest: sha256DigestSchema,
    qualificationReportDigest: sha256DigestSchema,
    qualificationProfileDigest: sha256DigestSchema,
    fabricDigest: sha256DigestSchema,
    trustPolicyDigest: sha256DigestSchema,
    targetScopeDigest: sha256DigestSchema,
    challengeDigest: sha256DigestSchema,
    configuredSignerIdentity: capabilitySnapshotSignerIdentitySchema,
    verifiedAt: timestampSchema,
    snapshotExpiresAt: timestampSchema,
  })
  .strict();

export type CapabilitySnapshotSignerIdentity = z.infer<
  typeof capabilitySnapshotSignerIdentitySchema
>;
export type CapabilitySnapshotTrustPolicy = z.infer<
  typeof capabilitySnapshotTrustPolicySchema
>;
export type CapabilitySnapshotChallengeReceipt = z.infer<
  typeof capabilitySnapshotChallengeReceiptSchema
>;
export type CapabilitySnapshotAttestationPredicate = z.infer<
  typeof capabilitySnapshotAttestationPredicateSchema
>;
export type CapabilitySnapshotAttestationStatement = z.infer<
  typeof capabilitySnapshotAttestationStatementSchema
>;
export type VerifiedCapabilitySnapshotEvidence = z.infer<
  typeof verifiedCapabilitySnapshotEvidenceSchema
>;

export type CapabilitySnapshotAttestationErrorCode =
  | 'invalid_input'
  | 'snapshot_digest_mismatch'
  | 'bindings_digest_mismatch'
  | 'qualification_report_digest_mismatch'
  | 'snapshot_binding_mismatch'
  | 'report_binding_mismatch'
  | 'qualification_profile_digest_mismatch'
  | 'fabric_digest_mismatch'
  | 'trust_policy_digest_mismatch'
  | 'audience_mismatch'
  | 'challenge_mismatch'
  | 'challenge_not_yet_valid'
  | 'challenge_expired'
  | 'snapshot_outside_challenge'
  | 'statement_subject_mismatch'
  | 'statement_predicate_mismatch'
  | 'qualification_required'
  | 'target_scope_mismatch'
  | 'operation_binding_mismatch'
  | 'fabric_target_mismatch'
  | 'snapshot_from_future'
  | 'snapshot_expired'
  | 'snapshot_too_old'
  | 'snapshot_ttl_exceeded';

const ERROR_MESSAGES: Readonly<
  Record<CapabilitySnapshotAttestationErrorCode, string>
> = Object.freeze({
  invalid_input: 'authenticated snapshot input is invalid',
  snapshot_digest_mismatch: 'capability snapshot digest does not match',
  bindings_digest_mismatch: 'runtime bindings digest does not match',
  qualification_report_digest_mismatch:
    'runtime qualification report digest does not match',
  snapshot_binding_mismatch: 'snapshot is not bound to the runtime bindings',
  report_binding_mismatch:
    'qualification report is not bound to the runtime bindings',
  qualification_profile_digest_mismatch:
    'qualification profile digest does not match',
  fabric_digest_mismatch: 'fabric digest does not match the trust policy',
  trust_policy_digest_mismatch: 'statement trust policy digest does not match',
  audience_mismatch: 'attestation audience does not match',
  challenge_mismatch: 'attestation challenge does not match',
  challenge_not_yet_valid: 'challenge is not yet valid',
  challenge_expired: 'challenge has expired',
  snapshot_outside_challenge:
    'snapshot observation is outside the challenge window',
  statement_subject_mismatch: 'attestation subject digest does not match',
  statement_predicate_mismatch: 'attestation predicate does not match',
  qualification_required: 'runtime qualification did not pass',
  target_scope_mismatch:
    'qualification coverage does not match the observed operation scope',
  operation_binding_mismatch:
    'qualification operation does not match the runtime bindings',
  fabric_target_mismatch: 'snapshot target does not belong to the fabric',
  snapshot_from_future: 'snapshot observation is in the future',
  snapshot_expired: 'snapshot has expired',
  snapshot_too_old: 'snapshot exceeds the maximum age',
  snapshot_ttl_exceeded: 'snapshot exceeds the maximum TTL',
});

export class CapabilitySnapshotAttestationError extends Error {
  readonly code: CapabilitySnapshotAttestationErrorCode;

  constructor(code: CapabilitySnapshotAttestationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CapabilitySnapshotAttestationError';
    this.code = code;
  }
}

function fail(code: CapabilitySnapshotAttestationErrorCode): never {
  throw new CapabilitySnapshotAttestationError(code);
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) return fail('invalid_input');
  return result.data;
}

export function parseCapabilitySnapshotTrustPolicy(
  input: unknown,
): CapabilitySnapshotTrustPolicy {
  return parseInput(capabilitySnapshotTrustPolicySchema, input);
}

export function parseCapabilitySnapshotChallengeReceipt(
  input: unknown,
): CapabilitySnapshotChallengeReceipt {
  return parseInput(capabilitySnapshotChallengeReceiptSchema, input);
}

export function parseCapabilitySnapshotAttestationStatement(
  input: unknown,
): CapabilitySnapshotAttestationStatement {
  return parseInput(capabilitySnapshotAttestationStatementSchema, input);
}

function normalizedFabric(fabric: Fabric): Fabric {
  return {
    apiVersion: fabric.apiVersion,
    kind: fabric.kind,
    zones: [...fabric.zones]
      .map((zone) => ({
        id: zone.id,
        trustLevel: zone.trustLevel,
        residencies: [...zone.residencies].sort(compareCodePointStrings),
        labels: zone.labels,
      }))
      .sort((left, right) => compareCodePointStrings(left.id, right.id)),
    classifications: [...fabric.classifications]
      .map((classification) => ({
        id: classification.id,
        rank: classification.rank,
        minTrustLevel: classification.minTrustLevel,
        allowedZones: [...classification.allowedZones].sort(
          compareCodePointStrings,
        ),
        allowedResidencies: [...classification.allowedResidencies].sort(
          compareCodePointStrings,
        ),
      }))
      .sort((left, right) => compareCodePointStrings(left.id, right.id)),
    targets: [...fabric.targets]
      .map((target) => ({
        id: target.id,
        zone: target.zone,
        adapter: { kind: target.adapter.kind },
        capabilities: [...target.capabilities].sort(compareCodePointStrings),
        expectedP95Ms: target.expectedP95Ms,
        costMicros: target.costMicros,
        labels: target.labels,
      }))
      .sort((left, right) => compareCodePointStrings(left.id, right.id)),
    policy: {
      // This is an ordered preference, not a set.
      zonePreference: [...fabric.policy.zonePreference],
      maxFallbacks: fabric.policy.maxFallbacks,
    },
  };
}

export function computeCapabilitySnapshotFabricDigest(
  input: unknown,
): `sha256:${string}` {
  const fabric = fabricSchema.parse(input);
  return sha256Digest(normalizedFabric(fabric));
}

export function computeCapabilitySnapshotTrustPolicyDigest(
  input: unknown,
): `sha256:${string}` {
  return sha256Digest(capabilitySnapshotTrustPolicySchema.parse(input));
}

export function computeCapabilitySnapshotChallengeDigest(
  input: unknown,
): `sha256:${string}` {
  const challenge = capabilitySnapshotChallengeValueSchema.parse(input);
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const decoded = new Uint8Array(32);
  let accumulator = 0;
  let availableBits = 0;
  let outputIndex = 0;
  for (const character of challenge) {
    accumulator = (accumulator << 6) | alphabet.indexOf(character);
    availableBits += 6;
    if (availableBits >= 8) {
      availableBits -= 8;
      decoded[outputIndex] = (accumulator >> availableBits) & 0xff;
      outputIndex += 1;
    }
  }
  return `sha256:${bytesToHex(sha256(decoded))}`;
}

type OperationScope = Readonly<{
  targetId: string;
  operation: string;
}>;

function operationKey(scope: OperationScope): string {
  return `${scope.targetId.length}:${scope.targetId}${scope.operation}`;
}

function compareOperationScope(
  left: OperationScope,
  right: OperationScope,
): number {
  const targetOrder = compareCodePointStrings(left.targetId, right.targetId);
  return targetOrder === 0
    ? compareCodePointStrings(left.operation, right.operation)
    : targetOrder;
}

function snapshotOperationScope(
  snapshot: CapabilitySnapshot,
): readonly OperationScope[] {
  return snapshot.targets
    .flatMap((target) =>
      target.capabilities
        .filter((capability) =>
          capability.startsWith(INTERNAL_OPERATION_CAPABILITY_PREFIX),
        )
        .map((capability) => ({
          targetId: target.targetId,
          operation: capability.slice(
            INTERNAL_OPERATION_CAPABILITY_PREFIX.length,
          ),
        })),
    )
    .sort(compareOperationScope);
}

function qualificationProfileScope(
  profile: RuntimeQualificationProfile,
): readonly OperationScope[] {
  return profile.targets
    .flatMap((target) =>
      target.operations.map((operation) => ({
        targetId: target.targetId,
        operation,
      })),
    )
    .sort(compareOperationScope);
}

function qualificationReportScope(
  report: RuntimeQualificationReport,
): readonly OperationScope[] {
  return report.results
    .map((result) => ({
      targetId: result.targetId,
      operation: result.operation,
    }))
    .sort(compareOperationScope);
}

function scopesEqual(
  left: readonly OperationScope[],
  right: readonly OperationScope[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) => operationKey(item) === operationKey(right[index]!),
    )
  );
}

function targetScopeContent(snapshot: CapabilitySnapshot) {
  const grouped = new Map<string, string[]>();
  for (const item of snapshotOperationScope(snapshot)) {
    const operations = grouped.get(item.targetId) ?? [];
    operations.push(item.operation);
    grouped.set(item.targetId, operations);
  }

  return {
    apiVersion: STAGEFABRIC_API_VERSION,
    kind: 'CapabilitySnapshotTargetScope' as const,
    targets: [...grouped]
      .map(([targetId, operations]) => ({ targetId, operations }))
      .sort((left, right) =>
        compareCodePointStrings(left.targetId, right.targetId),
      ),
  };
}

export function computeCapabilitySnapshotTargetScopeDigest(
  input: unknown,
): `sha256:${string}` {
  const snapshot = capabilitySnapshotSchema.parse(input);
  return sha256Digest(targetScopeContent(snapshot));
}

function digestHex(digest: string): string {
  return digest.slice('sha256:'.length);
}

interface ParsedEvidenceInputs {
  readonly fabric: Fabric;
  readonly snapshot: CapabilitySnapshot;
  readonly bindings: RuntimeBindings;
  readonly qualificationReport: RuntimeQualificationReport;
  readonly qualificationProfile: RuntimeQualificationProfile;
  readonly trustPolicy: CapabilitySnapshotTrustPolicy;
  readonly challenge: CapabilitySnapshotChallengeReceipt;
}

function validateEvidenceInputs(inputs: ParsedEvidenceInputs): {
  readonly fabricDigest: `sha256:${string}`;
  readonly qualificationProfileDigest: `sha256:${string}`;
  readonly trustPolicyDigest: `sha256:${string}`;
  readonly targetScopeDigest: `sha256:${string}`;
  readonly challengeDigest: `sha256:${string}`;
} {
  if (!verifyCapabilitySnapshotDigest(inputs.snapshot)) {
    fail('snapshot_digest_mismatch');
  }
  if (!verifyRuntimeBindingsDigest(inputs.bindings)) {
    fail('bindings_digest_mismatch');
  }
  if (!verifyRuntimeQualificationReportDigest(inputs.qualificationReport)) {
    fail('qualification_report_digest_mismatch');
  }
  if (inputs.snapshot.bindingDigest !== inputs.bindings.digest) {
    fail('snapshot_binding_mismatch');
  }
  if (inputs.qualificationReport.bindingDigest !== inputs.bindings.digest) {
    fail('report_binding_mismatch');
  }
  if (!inputs.qualificationReport.qualified) {
    fail('qualification_required');
  }

  const qualificationProfileDigest = computeRuntimeQualificationProfileDigest(
    inputs.qualificationProfile,
  );
  if (
    inputs.qualificationReport.profileDigest !== qualificationProfileDigest ||
    inputs.trustPolicy.qualificationProfileDigest !== qualificationProfileDigest
  ) {
    fail('qualification_profile_digest_mismatch');
  }

  const fabricDigest = computeCapabilitySnapshotFabricDigest(inputs.fabric);
  if (inputs.trustPolicy.fabricDigest !== fabricDigest) {
    fail('fabric_digest_mismatch');
  }
  if (inputs.challenge.audience !== inputs.trustPolicy.audience) {
    fail('audience_mismatch');
  }

  const fabricTargets = new Set(
    inputs.fabric.targets.map((target) => target.id),
  );
  if (
    inputs.snapshot.targets.some(
      (target) => !fabricTargets.has(target.targetId),
    )
  ) {
    fail('fabric_target_mismatch');
  }

  const snapshotScope = snapshotOperationScope(inputs.snapshot);
  const targetHealth = new Map(
    inputs.snapshot.targets.map((target) => [target.targetId, target.healthy]),
  );
  if (snapshotScope.some((scope) => !targetHealth.get(scope.targetId))) {
    fail('target_scope_mismatch');
  }
  const profileScope = qualificationProfileScope(inputs.qualificationProfile);
  const reportScope = qualificationReportScope(inputs.qualificationReport);
  if (
    snapshotScope.length === 0 ||
    !scopesEqual(snapshotScope, profileScope) ||
    !scopesEqual(snapshotScope, reportScope)
  ) {
    fail('target_scope_mismatch');
  }

  const bindingOperations = new Map(
    inputs.bindings.targets.flatMap((target) =>
      target.operations.map(
        (operation) =>
          [
            operationKey({
              targetId: target.targetId,
              operation: operation.operation,
            }),
            operation.kind,
          ] as const,
      ),
    ),
  );
  for (const result of inputs.qualificationReport.results) {
    if (
      bindingOperations.get(
        operationKey({
          targetId: result.targetId,
          operation: result.operation,
        }),
      ) !== result.operationKind
    ) {
      fail('operation_binding_mismatch');
    }
  }

  const ttlMs =
    Date.parse(inputs.snapshot.expiresAt) -
    Date.parse(inputs.snapshot.observedAt);
  if (ttlMs > inputs.trustPolicy.maxSnapshotTtlSeconds * 1_000) {
    fail('snapshot_ttl_exceeded');
  }

  const skewMs = inputs.trustPolicy.clockSkewSeconds * 1_000;
  const observedMs = Date.parse(inputs.snapshot.observedAt);
  const challengeIssuedMs = Date.parse(inputs.challenge.issuedAt);
  const challengeExpiresMs = Date.parse(inputs.challenge.expiresAt);
  if (
    observedMs < challengeIssuedMs - skewMs ||
    observedMs >= challengeExpiresMs + skewMs
  ) {
    fail('snapshot_outside_challenge');
  }

  return {
    fabricDigest,
    qualificationProfileDigest,
    trustPolicyDigest: computeCapabilitySnapshotTrustPolicyDigest(
      inputs.trustPolicy,
    ),
    targetScopeDigest: computeCapabilitySnapshotTargetScopeDigest(
      inputs.snapshot,
    ),
    challengeDigest: computeCapabilitySnapshotChallengeDigest(
      inputs.challenge.value,
    ),
  };
}

function parseEvidenceInputs(input: {
  readonly fabric: unknown;
  readonly snapshot: unknown;
  readonly bindings: unknown;
  readonly qualificationReport: unknown;
  readonly qualificationProfile: unknown;
  readonly trustPolicy: unknown;
  readonly challenge: unknown;
}): ParsedEvidenceInputs {
  return {
    fabric: parseInput(fabricSchema, input.fabric),
    snapshot: parseInput(capabilitySnapshotSchema, input.snapshot),
    bindings: parseInput(runtimeBindingsSchema, input.bindings),
    qualificationReport: parseInput(
      runtimeQualificationReportSchema,
      input.qualificationReport,
    ),
    qualificationProfile: parseInput(
      runtimeQualificationProfileSchema,
      input.qualificationProfile,
    ),
    trustPolicy: parseCapabilitySnapshotTrustPolicy(input.trustPolicy),
    challenge: parseCapabilitySnapshotChallengeReceipt(input.challenge),
  };
}

export interface CreateCapabilitySnapshotAttestationStatementInput {
  readonly fabric: unknown;
  readonly snapshot: unknown;
  readonly bindings: unknown;
  readonly qualificationReport: unknown;
  readonly qualificationProfile: unknown;
  readonly trustPolicy: unknown;
  readonly challenge: unknown;
}

export function createCapabilitySnapshotAttestationStatement(
  input: CreateCapabilitySnapshotAttestationStatementInput,
): CapabilitySnapshotAttestationStatement {
  const parsed = parseEvidenceInputs(input);
  const digests = validateEvidenceInputs(parsed);

  return capabilitySnapshotAttestationStatementSchema.parse({
    _type: CAPABILITY_SNAPSHOT_STATEMENT_TYPE,
    subject: [
      {
        name: CAPABILITY_SNAPSHOT_SUBJECTS.snapshot,
        // snapshot.digest is the canonical CapabilitySnapshot content digest;
        // the self-referential digest field is excluded by its sealer.
        digest: { sha256: digestHex(parsed.snapshot.digest) },
      },
      {
        name: CAPABILITY_SNAPSHOT_SUBJECTS.bindings,
        digest: { sha256: digestHex(parsed.bindings.digest) },
      },
      {
        name: CAPABILITY_SNAPSHOT_SUBJECTS.qualificationReport,
        digest: { sha256: digestHex(parsed.qualificationReport.digest) },
      },
    ],
    predicateType: CAPABILITY_SNAPSHOT_PREDICATE_TYPE,
    predicate: {
      apiVersion: STAGEFABRIC_API_VERSION,
      kind: 'CapabilitySnapshotAttestation',
      audience: parsed.trustPolicy.audience,
      authority: CAPABILITY_SNAPSHOT_AUTHORITY,
      fabricDigest: digests.fabricDigest,
      qualificationProfileDigest: digests.qualificationProfileDigest,
      trustPolicyDigest: digests.trustPolicyDigest,
      targetScopeDigest: digests.targetScopeDigest,
      challengeDigest: digests.challengeDigest,
      challengeIssuedAt: parsed.challenge.issuedAt,
      challengeExpiresAt: parsed.challenge.expiresAt,
      observedAt: parsed.snapshot.observedAt,
      expiresAt: parsed.snapshot.expiresAt,
    },
  });
}

export interface VerifyCapabilitySnapshotAttestationSemanticsInput {
  readonly statement: unknown;
  readonly fabric: unknown;
  readonly snapshot: unknown;
  readonly bindings: unknown;
  readonly qualificationReport: unknown;
  readonly qualificationProfile: unknown;
  readonly trustPolicy: unknown;
  readonly expectedChallenge: unknown;
  readonly evaluatedAt: unknown;
}

function sameSubject(
  actual: CapabilitySnapshotAttestationStatement['subject'][number],
  expected: CapabilitySnapshotAttestationStatement['subject'][number],
): boolean {
  return (
    actual.name === expected.name &&
    actual.digest.sha256 === expected.digest.sha256
  );
}

export function verifyCapabilitySnapshotAttestationSemantics(
  input: VerifyCapabilitySnapshotAttestationSemanticsInput,
): VerifiedCapabilitySnapshotEvidence {
  const challenge = parseCapabilitySnapshotChallengeReceipt(
    input.expectedChallenge,
  );
  const parsed = parseEvidenceInputs({ ...input, challenge });
  const statement = parseCapabilitySnapshotAttestationStatement(
    input.statement,
  );
  const evaluatedAt = parseInput(timestampSchema, input.evaluatedAt);
  const expected = createCapabilitySnapshotAttestationStatement({
    ...parsed,
    challenge,
  });
  const digests = validateEvidenceInputs(parsed);

  if (
    !statement.subject.every((subject, index) =>
      sameSubject(subject, expected.subject[index]!),
    )
  ) {
    fail('statement_subject_mismatch');
  }
  if (sha256Digest(statement.predicate) !== sha256Digest(expected.predicate)) {
    if (statement.predicate.audience !== parsed.trustPolicy.audience) {
      fail('audience_mismatch');
    }
    if (statement.predicate.challengeDigest !== digests.challengeDigest) {
      fail('challenge_mismatch');
    }
    if (
      statement.predicate.challengeIssuedAt !== challenge.issuedAt ||
      statement.predicate.challengeExpiresAt !== challenge.expiresAt
    ) {
      fail('challenge_mismatch');
    }
    if (statement.predicate.trustPolicyDigest !== digests.trustPolicyDigest) {
      fail('trust_policy_digest_mismatch');
    }
    fail('statement_predicate_mismatch');
  }

  const evaluatedMs = Date.parse(evaluatedAt);
  const skewMs = parsed.trustPolicy.clockSkewSeconds * 1_000;
  const issuedMs = Date.parse(challenge.issuedAt);
  const challengeExpiresMs = Date.parse(challenge.expiresAt);
  const observedMs = Date.parse(parsed.snapshot.observedAt);
  const snapshotExpiresMs = Date.parse(parsed.snapshot.expiresAt);

  if (issuedMs > evaluatedMs + skewMs) fail('challenge_not_yet_valid');
  if (evaluatedMs >= challengeExpiresMs + skewMs) fail('challenge_expired');
  if (observedMs > evaluatedMs + skewMs) fail('snapshot_from_future');
  if (evaluatedMs >= snapshotExpiresMs + skewMs) fail('snapshot_expired');
  if (
    evaluatedMs - observedMs >
    parsed.trustPolicy.maxSnapshotAgeSeconds * 1_000 + skewMs
  ) {
    fail('snapshot_too_old');
  }

  return verifiedCapabilitySnapshotEvidenceSchema.parse({
    apiVersion: STAGEFABRIC_API_VERSION,
    kind: 'VerifiedCapabilitySnapshotEvidence',
    authority: CAPABILITY_SNAPSHOT_AUTHORITY,
    snapshotDigest: parsed.snapshot.digest,
    bindingDigest: parsed.bindings.digest,
    qualificationReportDigest: parsed.qualificationReport.digest,
    qualificationProfileDigest: digests.qualificationProfileDigest,
    fabricDigest: digests.fabricDigest,
    trustPolicyDigest: digests.trustPolicyDigest,
    targetScopeDigest: digests.targetScopeDigest,
    challengeDigest: digests.challengeDigest,
    configuredSignerIdentity: parsed.trustPolicy.signerIdentity,
    verifiedAt: evaluatedAt,
    snapshotExpiresAt: parsed.snapshot.expiresAt,
  });
}

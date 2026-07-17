import {
  capabilitySnapshotChallengeReceiptSchema,
  capabilitySnapshotTrustPolicySchema,
  verifyCapabilitySnapshotAttestationSemantics,
  type VerifiedCapabilitySnapshotEvidence,
} from '../domain/capability-snapshot-attestation.js';
import { sha256Digest } from '../domain/canonical.js';
import { runtimeBindingsSchema } from '../domain/runtime-bindings.js';
import {
  runtimeQualificationProfileSchema,
  runtimeQualificationReportSchema,
} from '../domain/runtime-qualification.js';
import { capabilitySnapshotSchema, fabricSchema } from '../domain/schema.js';
import {
  IN_TOTO_STATEMENT_PAYLOAD_TYPE,
  type CapabilitySnapshotAttestationVerifier,
  type VerifiedAttestationSigner,
} from '../ports/capability-snapshot-attestation-verifier.js';

const MAX_STATEMENT_BYTES = 256 * 1_024;

export type AuthenticateCapabilitySnapshotErrorCode =
  | 'input_invalid'
  | 'verification_failed'
  | 'payload_type_invalid'
  | 'payload_invalid'
  | 'signer_mismatch';

/** Stable application error that never includes envelope or evidence content. */
export class AuthenticateCapabilitySnapshotError extends Error {
  readonly code: AuthenticateCapabilitySnapshotErrorCode;

  constructor(code: AuthenticateCapabilitySnapshotErrorCode) {
    super(code);
    this.name = 'AuthenticateCapabilitySnapshotError';
    this.code = code;
  }
}

export interface AuthenticateCapabilitySnapshotRequest {
  /** Opaque DSSE bundle bytes; only the injected verifier may decode them. */
  readonly bundle: Uint8Array;
  readonly fabric: unknown;
  readonly snapshot: unknown;
  readonly bindings: unknown;
  readonly qualificationReport: unknown;
  readonly qualificationProfile: unknown;
  readonly trustPolicy: unknown;
  readonly expectedChallenge: unknown;
  /** A function is evaluated only after cryptographic verification completes. */
  readonly evaluatedAt: unknown;
}

export interface AuthenticatedCapabilitySnapshot {
  readonly authorizationDigest: `sha256:${string}`;
  readonly evidence: VerifiedCapabilitySnapshotEvidence;
  readonly signer: VerifiedAttestationSigner;
}

function copyVerifiedSigner(input: unknown): VerifiedAttestationSigner {
  if (typeof input !== 'object' || input === null) {
    throw new AuthenticateCapabilitySnapshotError('signer_mismatch');
  }
  const signer = input as Record<string, unknown>;
  if (
    typeof signer.issuer !== 'string' ||
    (signer.identityType !== 'uri' && signer.identityType !== 'email') ||
    typeof signer.identity !== 'string'
  ) {
    throw new AuthenticateCapabilitySnapshotError('signer_mismatch');
  }
  return Object.freeze({
    issuer: signer.issuer,
    identityType: signer.identityType,
    identity: signer.identity,
  });
}

function invalidInput(): never {
  throw new AuthenticateCapabilitySnapshotError('input_invalid');
}

function parseTrustedInputs(request: AuthenticateCapabilitySnapshotRequest) {
  const fabric = fabricSchema.safeParse(request.fabric);
  const snapshot = capabilitySnapshotSchema.safeParse(request.snapshot);
  const bindings = runtimeBindingsSchema.safeParse(request.bindings);
  const qualificationReport = runtimeQualificationReportSchema.safeParse(
    request.qualificationReport,
  );
  const qualificationProfile = runtimeQualificationProfileSchema.safeParse(
    request.qualificationProfile,
  );
  const trustPolicy = capabilitySnapshotTrustPolicySchema.safeParse(
    request.trustPolicy,
  );
  const expectedChallenge = capabilitySnapshotChallengeReceiptSchema.safeParse(
    request.expectedChallenge,
  );

  if (
    !fabric.success ||
    !snapshot.success ||
    !bindings.success ||
    !qualificationReport.success ||
    !qualificationProfile.success ||
    !trustPolicy.success ||
    !expectedChallenge.success
  ) {
    return invalidInput();
  }

  return {
    fabric: fabric.data,
    snapshot: snapshot.data,
    bindings: bindings.data,
    qualificationReport: qualificationReport.data,
    qualificationProfile: qualificationProfile.data,
    trustPolicy: trustPolicy.data,
    expectedChallenge: expectedChallenge.data,
  };
}

function parseVerifiedStatement(payload: Uint8Array): unknown {
  if (payload.byteLength === 0 || payload.byteLength > MAX_STATEMENT_BYTES) {
    throw new AuthenticateCapabilitySnapshotError('payload_invalid');
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return JSON.parse(text) as unknown;
  } catch {
    throw new AuthenticateCapabilitySnapshotError('payload_invalid');
  }
}

function resolveEvaluatedAt(source: unknown): unknown {
  if (typeof source !== 'function') return source;
  try {
    return (source as () => unknown)();
  } catch {
    return invalidInput();
  }
}

function signerMatches(
  signer: VerifiedAttestationSigner,
  policy: ReturnType<typeof parseTrustedInputs>['trustPolicy'],
): boolean {
  return (
    signer.issuer === policy.certificateIssuer &&
    signer.identityType === policy.signerIdentity.type &&
    signer.identity === policy.signerIdentity.value
  );
}

function authorizationDigest(
  evidence: VerifiedCapabilitySnapshotEvidence,
  signer: VerifiedAttestationSigner,
  policy: ReturnType<typeof parseTrustedInputs>['trustPolicy'],
): `sha256:${string}` {
  // Deliberately construct the stable authorization projection instead of
  // spreading evidence: verifiedAt is observation time, not authorization.
  return sha256Digest({
    apiVersion: evidence.apiVersion,
    kind: 'CapabilitySnapshotAuthorization',
    authority: evidence.authority,
    snapshotDigest: evidence.snapshotDigest,
    bindingDigest: evidence.bindingDigest,
    qualificationReportDigest: evidence.qualificationReportDigest,
    qualificationProfileDigest: evidence.qualificationProfileDigest,
    fabricDigest: evidence.fabricDigest,
    trustPolicyDigest: evidence.trustPolicyDigest,
    targetScopeDigest: evidence.targetScopeDigest,
    challengeDigest: evidence.challengeDigest,
    audience: policy.audience,
    challengeIssuedAt: evidence.challengeIssuedAt,
    challengeExpiresAt: evidence.challengeExpiresAt,
    configuredSignerIdentity: evidence.configuredSignerIdentity,
    verifiedSigner: {
      issuer: signer.issuer,
      identityType: signer.identityType,
      identity: signer.identity,
    },
    snapshotExpiresAt: evidence.snapshotExpiresAt,
  });
}

/**
 * Authenticates an opaque bundle before parsing its signed statement, then
 * verifies the statement against the complete local evidence set.
 */
export async function authenticateCapabilitySnapshot(
  request: AuthenticateCapabilitySnapshotRequest,
  verifier: CapabilitySnapshotAttestationVerifier,
): Promise<AuthenticatedCapabilitySnapshot> {
  const trusted = parseTrustedInputs(request);
  if (!(request.bundle instanceof Uint8Array)) return invalidInput();

  let verified: unknown;
  try {
    // Isolate the verifier from caller mutation before its first async boundary.
    verified = await verifier.verify(new Uint8Array(request.bundle));
  } catch {
    throw new AuthenticateCapabilitySnapshotError('verification_failed');
  }

  if (typeof verified !== 'object' || verified === null) {
    throw new AuthenticateCapabilitySnapshotError('payload_invalid');
  }
  const envelope = verified as Record<string, unknown>;
  if (envelope.payloadType !== IN_TOTO_STATEMENT_PAYLOAD_TYPE) {
    throw new AuthenticateCapabilitySnapshotError('payload_type_invalid');
  }
  if (!(envelope.payload instanceof Uint8Array)) {
    throw new AuthenticateCapabilitySnapshotError('payload_invalid');
  }

  // The signed payload is copied and parsed only after cryptographic success.
  const statement = parseVerifiedStatement(new Uint8Array(envelope.payload));
  const signer = copyVerifiedSigner(envelope.signer);
  if (!signerMatches(signer, trusted.trustPolicy)) {
    throw new AuthenticateCapabilitySnapshotError('signer_mismatch');
  }

  const evidence = verifyCapabilitySnapshotAttestationSemantics({
    statement,
    ...trusted,
    evaluatedAt: resolveEvaluatedAt(request.evaluatedAt),
  });

  return Object.freeze({
    authorizationDigest: authorizationDigest(
      evidence,
      signer,
      trusted.trustPolicy,
    ),
    evidence,
    signer,
  });
}

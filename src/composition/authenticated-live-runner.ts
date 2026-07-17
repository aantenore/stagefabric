import type { ZodType } from 'zod';

import {
  authenticateCapabilitySnapshot,
  type AuthenticatedCapabilitySnapshot,
} from '../application/authenticate-capability-snapshot.js';
import type { ExecutionTraceEvent } from '../application/executor.js';
import { planStageGraph, type ExecutionPlan } from '../application/planner.js';
import {
  capabilitySnapshotChallengeReceiptSchema,
  capabilitySnapshotTrustPolicySchema,
  computeCapabilitySnapshotFabricDigest,
} from '../domain/capability-snapshot-attestation.js';
import {
  runtimeQualificationProfileSchema,
  runtimeQualificationReportSchema,
} from '../domain/runtime-qualification.js';
import { capabilitySnapshotSchema } from '../domain/schema.js';
import type { CapabilitySnapshotAttestationVerifier } from '../ports/capability-snapshot-attestation-verifier.js';
import type { CapabilitySnapshotChallengeConsumer } from '../ports/capability-snapshot-challenge-consumer.js';
import {
  executePreparedLivePlan,
  liveRunnerTimestamp,
  prepareLiveRunRequest,
  type LiveRunnerOptions,
  type LiveRunRequest,
  type PreparedLiveRunRequest,
} from './live-runner.js';

export type AuthenticatedLiveRunnerErrorCode =
  | 'authenticated_input_invalid'
  | 'authorization_changed'
  | 'authorization_context_mismatch'
  | 'challenge_already_consumed'
  | 'challenge_consume_failed';

/** Content-free trust-fence failure. */
export class AuthenticatedLiveRunnerError extends Error {
  readonly code: AuthenticatedLiveRunnerErrorCode;

  constructor(code: AuthenticatedLiveRunnerErrorCode) {
    super(code);
    this.name = 'AuthenticatedLiveRunnerError';
    this.code = code;
  }
}

export interface AuthenticatedLiveRunRequest extends LiveRunRequest {
  readonly attestationBundle: Uint8Array;
  readonly snapshot: unknown;
  readonly qualificationReport: unknown;
  readonly qualificationProfile: unknown;
  readonly trustPolicy: unknown;
  readonly expectedChallenge: unknown;
}

export interface AuthenticatedLiveRunnerOptions extends LiveRunnerOptions {
  readonly verifier: CapabilitySnapshotAttestationVerifier;
  readonly challengeConsumer: CapabilitySnapshotChallengeConsumer;
}

export interface AuthenticatedLivePlanOptions {
  readonly verifier: CapabilitySnapshotAttestationVerifier;
  readonly now?: () => Date;
}

export interface AuthenticatedLivePlanResult {
  readonly bindingDigest: string;
  readonly plan: ExecutionPlan;
  readonly trust: AuthenticatedCapabilitySnapshot;
}

export interface AuthenticatedLiveRunResult {
  readonly bindingDigest: string;
  readonly plan: ExecutionPlan;
  readonly trust: AuthenticatedCapabilitySnapshot;
  /** Content-free execution evidence; inputs and intermediate values are omitted. */
  readonly execution: {
    readonly planDigest: string;
    readonly stages: readonly {
      readonly stageId: string;
      readonly targetId: string;
      readonly zone: string;
    }[];
    readonly trace: readonly ExecutionTraceEvent[];
  };
  /** Only unconsumed graph outputs; original graph inputs are never echoed. */
  readonly outputs: Readonly<Record<string, unknown>>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function parseOrFail<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AuthenticatedLiveRunnerError('authenticated_input_invalid');
  }
  return deepFreeze(parsed.data);
}

interface PreparedAuthenticatedEvidence {
  readonly bundle: Uint8Array;
  readonly fabric: PreparedLiveRunRequest['fabric'];
  readonly snapshot: ReturnType<typeof capabilitySnapshotSchema.parse>;
  readonly bindings: PreparedLiveRunRequest['bindings'];
  readonly qualificationReport: ReturnType<
    typeof runtimeQualificationReportSchema.parse
  >;
  readonly qualificationProfile: ReturnType<
    typeof runtimeQualificationProfileSchema.parse
  >;
  readonly trustPolicy: ReturnType<
    typeof capabilitySnapshotTrustPolicySchema.parse
  >;
  readonly expectedChallenge: ReturnType<
    typeof capabilitySnapshotChallengeReceiptSchema.parse
  >;
}

function prepareAuthenticatedEvidence(
  request: AuthenticatedLiveRunRequest,
  prepared: PreparedLiveRunRequest,
): PreparedAuthenticatedEvidence {
  if (!(request.attestationBundle instanceof Uint8Array)) {
    throw new AuthenticatedLiveRunnerError('authenticated_input_invalid');
  }
  return {
    bundle: new Uint8Array(request.attestationBundle),
    fabric: deepFreeze(prepared.fabric),
    snapshot: parseOrFail(capabilitySnapshotSchema, request.snapshot),
    bindings: deepFreeze(prepared.bindings),
    qualificationReport: parseOrFail(
      runtimeQualificationReportSchema,
      request.qualificationReport,
    ),
    qualificationProfile: parseOrFail(
      runtimeQualificationProfileSchema,
      request.qualificationProfile,
    ),
    trustPolicy: parseOrFail(
      capabilitySnapshotTrustPolicySchema,
      request.trustPolicy,
    ),
    expectedChallenge: parseOrFail(
      capabilitySnapshotChallengeReceiptSchema,
      request.expectedChallenge,
    ),
  };
}

function authenticationRequest(
  evidence: PreparedAuthenticatedEvidence,
  evaluatedAt: unknown,
) {
  return {
    ...evidence,
    evaluatedAt,
  };
}

function assertAuthorizationContext(
  prepared: PreparedLiveRunRequest,
  plan: ExecutionPlan,
  authentication: AuthenticatedCapabilitySnapshot,
): void {
  let fabricDigest: string;
  try {
    fabricDigest = computeCapabilitySnapshotFabricDigest(prepared.fabric);
  } catch {
    throw new AuthenticatedLiveRunnerError('authorization_context_mismatch');
  }
  if (
    prepared.bindings.digest !== authentication.evidence.bindingDigest ||
    fabricDigest !== authentication.evidence.fabricDigest ||
    plan.snapshotDigest !== authentication.evidence.snapshotDigest
  ) {
    throw new AuthenticatedLiveRunnerError('authorization_context_mismatch');
  }
}

async function consumeChallenge(
  authentication: AuthenticatedCapabilitySnapshot,
  consumer: CapabilitySnapshotChallengeConsumer,
): Promise<void> {
  let consumed: boolean;
  try {
    consumed = await consumer.consume({
      // The domain evidence schema has already enforced the sha256 shape.
      challengeDigest: authentication.evidence
        .challengeDigest as `sha256:${string}`,
      authorizationDigest: authentication.authorizationDigest,
      consumedAt: authentication.evidence.verifiedAt,
    });
  } catch {
    throw new AuthenticatedLiveRunnerError('challenge_consume_failed');
  }
  if (!consumed) {
    throw new AuthenticatedLiveRunnerError('challenge_already_consumed');
  }
}

/** Verifies once and plans without consuming the challenge or touching a provider. */
export async function planAuthenticatedLiveStageGraph(
  request: AuthenticatedLiveRunRequest,
  options: AuthenticatedLivePlanOptions,
): Promise<AuthenticatedLivePlanResult> {
  const prepared = prepareLiveRunRequest(request);
  const authenticatedEvidence = prepareAuthenticatedEvidence(request, prepared);
  const now = options.now ?? (() => new Date());
  const trust = await authenticateCapabilitySnapshot(
    authenticationRequest(authenticatedEvidence, () =>
      liveRunnerTimestamp(now),
    ),
    options.verifier,
  );
  const plan = planStageGraph({
    fabric: authenticatedEvidence.fabric,
    graph: prepared.graph,
    snapshot: authenticatedEvidence.snapshot,
    evaluatedAt: trust.evidence.verifiedAt,
  });
  assertAuthorizationContext(prepared, plan, trust);
  return { bindingDigest: prepared.bindings.digest, plan, trust };
}

/**
 * Runs a signed snapshot through a double-verification TOCTOU fence. No live
 * provider adapter is constructed and no credential is resolved until the
 * challenge store has atomically accepted the authorization digest.
 */
export async function runAuthenticatedLiveStageGraph(
  request: AuthenticatedLiveRunRequest,
  options: AuthenticatedLiveRunnerOptions,
): Promise<AuthenticatedLiveRunResult> {
  const prepared = prepareLiveRunRequest(request);
  const authenticatedEvidence = prepareAuthenticatedEvidence(request, prepared);
  const now = options.now ?? (() => new Date());

  const firstAuthentication = await authenticateCapabilitySnapshot(
    authenticationRequest(authenticatedEvidence, () =>
      liveRunnerTimestamp(now),
    ),
    options.verifier,
  );

  const firstPlan = planStageGraph({
    fabric: authenticatedEvidence.fabric,
    graph: prepared.graph,
    snapshot: authenticatedEvidence.snapshot,
    evaluatedAt: firstAuthentication.evidence.verifiedAt,
  });
  assertAuthorizationContext(prepared, firstPlan, firstAuthentication);

  const secondAuthentication = await authenticateCapabilitySnapshot(
    authenticationRequest(authenticatedEvidence, () =>
      liveRunnerTimestamp(now),
    ),
    options.verifier,
  );
  if (
    firstAuthentication.authorizationDigest !==
    secondAuthentication.authorizationDigest
  ) {
    throw new AuthenticatedLiveRunnerError('authorization_changed');
  }

  // Per-target validity is planner time-dependent even when the global signed
  // snapshot remains fresh. Replan at the post-verification fence and execute
  // only that final plan.
  const plan = planStageGraph({
    fabric: authenticatedEvidence.fabric,
    graph: prepared.graph,
    snapshot: authenticatedEvidence.snapshot,
    evaluatedAt: secondAuthentication.evidence.verifiedAt,
  });
  assertAuthorizationContext(prepared, plan, secondAuthentication);
  await consumeChallenge(secondAuthentication, options.challengeConsumer);

  const { execution, outputs } = await executePreparedLivePlan(
    prepared,
    plan,
    options,
  );
  return {
    bindingDigest: prepared.bindings.digest,
    plan,
    trust: secondAuthentication,
    execution: {
      planDigest: execution.planDigest,
      stages: execution.stages.map(({ stageId, targetId, zone }) => ({
        stageId,
        targetId,
        zone,
      })),
      trace: execution.trace,
    },
    outputs,
  };
}

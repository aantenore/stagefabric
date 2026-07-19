import { verifyExecutionPlanDigest } from '../application/planner.js';
import { sha256Digest } from '../domain/canonical.js';
import {
  executionPlacementEvidenceRunIdSchema,
  executionPlacementEvidenceTraceEventSchema,
  sealExecutionPlacementEvidence,
  type ExecutionPlacementEvidence,
  type ExecutionPlacementEvidencePlacement,
  type ExecutionPlacementEvidenceTraceEvent,
} from '../domain/execution-placement-evidence.js';
import { verifyCapabilitySnapshotDigest } from '../domain/snapshot.js';
import type { LiveRunResult } from './live-runner.js';

export class ExecutionPlacementEvidenceCreationError extends Error {
  readonly code = 'execution_evidence_live_result_invalid' as const;

  constructor() {
    super('execution_evidence_live_result_invalid');
    this.name = 'ExecutionPlacementEvidenceCreationError';
  }
}

export interface CreateExecutionPlacementEvidenceRequest {
  /** Host correlation identifier. Only its canonical SHA-256 enters evidence. */
  readonly runId: string;
  /** Host observation time captured after the successful live run. */
  readonly observedAt: string;
  readonly result: LiveRunResult;
}

function invalidResult(): never {
  throw new ExecutionPlacementEvidenceCreationError();
}

function digestIdentifier(value: string): `sha256:${string}` {
  return sha256Digest(value);
}

function assertLiveResultCoherence(result: LiveRunResult): void {
  const { plan, snapshot, execution } = result;
  if (
    !verifyExecutionPlanDigest(plan) ||
    !verifyCapabilitySnapshotDigest(snapshot) ||
    plan.bindingDigest === undefined ||
    plan.bindingDigest !== result.bindingDigest ||
    snapshot.bindingDigest !== result.bindingDigest ||
    plan.snapshotDigest !== snapshot.digest ||
    execution.planDigest !== plan.digest ||
    execution.stages.length !== plan.stages.length
  ) {
    invalidResult();
  }

  const planStages = new Map(
    plan.stages.map((stage) => [stage.stageId, stage]),
  );
  for (const [index, stage] of execution.stages.entries()) {
    const planned = plan.stages[index];
    if (planned === undefined || stage.stageId !== planned.stageId) {
      invalidResult();
    }
  }

  for (const event of execution.trace) {
    const stage = planStages.get(event.stageId);
    const placement =
      stage === undefined
        ? undefined
        : [stage.primary, ...stage.fallbacks][event.attempt - 1];
    if (
      placement === undefined ||
      placement.targetId !== event.targetId ||
      placement.zone !== event.zone ||
      placement.adapterKind !== event.adapterKind
    ) {
      invalidResult();
    }
  }
}

function traceEvidence(
  result: LiveRunResult,
): readonly ExecutionPlacementEvidenceTraceEvent[] {
  return result.execution.trace.map((event) => {
    const projected = executionPlacementEvidenceTraceEventSchema.safeParse({
      stageIdDigest: digestIdentifier(event.stageId),
      targetIdDigest: digestIdentifier(event.targetId),
      zoneDigest: digestIdentifier(event.zone),
      adapterKindDigest: digestIdentifier(event.adapterKind),
      attempt: event.attempt,
      status: event.outcome,
      reasonCode: event.reasonCode,
      ...(event.statusCode === undefined
        ? {}
        : { statusCode: event.statusCode }),
    });
    if (!projected.success) invalidResult();
    return projected.data;
  });
}

function placementEvidence(
  result: LiveRunResult,
): readonly ExecutionPlacementEvidencePlacement[] {
  return result.execution.stages.map((stage) => {
    const matching = result.execution.trace.filter(
      (event) =>
        event.stageId === stage.stageId &&
        event.targetId === stage.targetId &&
        event.zone === stage.zone &&
        event.outcome === 'succeeded' &&
        event.reasonCode === 'completed',
    );
    if (matching.length !== 1) invalidResult();
    const completed = matching[0]!;
    return {
      stageIdDigest: digestIdentifier(stage.stageId),
      targetIdDigest: digestIdentifier(stage.targetId),
      zoneDigest: digestIdentifier(stage.zone),
      adapterKindDigest: digestIdentifier(completed.adapterKind),
      attempt: completed.attempt,
      status: 'succeeded',
      reasonCode: 'completed',
    };
  });
}

/**
 * Projects a successful live run into observation-only, content-free evidence.
 * The projection never reads inputs, outputs, models, endpoints, or credentials.
 */
export function createExecutionPlacementEvidence(
  request: CreateExecutionPlacementEvidenceRequest,
): ExecutionPlacementEvidence {
  const runId = executionPlacementEvidenceRunIdSchema.parse(request.runId);
  assertLiveResultCoherence(request.result);

  return sealExecutionPlacementEvidence({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'ExecutionPlacementEvidence',
    producer: 'stagefabric',
    disclosure: 'content-free',
    authority: 'observation-only',
    runIdDigest: sha256Digest(runId),
    observedAt: request.observedAt,
    planDigest: request.result.plan.digest,
    bindingDigest: request.result.bindingDigest,
    snapshotDigest: request.result.snapshot.digest,
    egressDigest: request.result.plan.egress.digest,
    placements: placementEvidence(request.result),
    trace: traceEvidence(request.result),
  });
}

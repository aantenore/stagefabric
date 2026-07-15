import { compareCodePointStrings, sha256Digest } from '../domain/canonical.js';
import {
  capabilitySnapshotSchema,
  fabricSchema,
  internalOperationCapability,
  stageGraphSchema,
  timestampSchema,
  type CapabilitySnapshot,
  type CapabilityTargetState,
  type Classification,
  type Fabric,
  type FabricTarget,
  type Stage,
  type StageGraph,
} from '../domain/schema.js';
import { verifyCapabilitySnapshotDigest } from '../domain/snapshot.js';

export type PlannerErrorCode =
  | 'schema_invalid'
  | 'snapshot_digest_mismatch'
  | 'snapshot_not_yet_valid'
  | 'snapshot_expired'
  | 'snapshot_unknown_target'
  | 'unknown_classification'
  | 'unknown_zone'
  | 'missing_reference'
  | 'type_mismatch'
  | 'cycle_detected'
  | 'classification_required'
  | 'declassification_required'
  | 'invalid_declassification'
  | 'no_eligible_target';

export class PlannerError extends Error {
  readonly code: PlannerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PlannerErrorCode,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'PlannerError';
    this.code = code;
    this.details = details;
  }
}

export type RejectionReasonCode =
  | 'snapshot_missing'
  | 'snapshot_unhealthy'
  | 'snapshot_not_yet_observed'
  | 'snapshot_target_expired'
  | 'stage_zone_disallowed'
  | 'classification_zone_disallowed'
  | 'classification_residency_disallowed'
  | 'trust_too_low'
  | 'residency_unsupported'
  | 'operation_unavailable'
  | 'capability_not_configured'
  | 'capability_unavailable';

export interface RejectionReason {
  code: RejectionReasonCode;
  values?: readonly string[];
  expected?: number;
  actual?: number;
}

export interface CandidateRejection {
  targetId: string;
  reasons: readonly RejectionReason[];
}

export interface Placement {
  targetId: string;
  zone: string;
  adapterKind: string;
  rank: {
    zonePreference: number;
    expectedP95Ms: number;
    costMicros: number;
  };
}

export interface PlannedInput {
  name: string;
  ref: string;
  type: string;
  classification: string;
  residencies: readonly string[];
}

export interface PlannedOutput {
  name: string;
  type: string;
  classification: string;
  residencies: readonly string[];
  declassification?: {
    authorityCapability: string;
    justification: string;
  };
}

export interface StageExecutionPlan {
  stageId: string;
  operation: string;
  processingClassification: string;
  requiredCapabilities: readonly string[];
  requiredResidencies: readonly string[];
  inputs: readonly PlannedInput[];
  outputs: readonly PlannedOutput[];
  primary: Placement;
  fallbacks: readonly Placement[];
  rejected: readonly CandidateRejection[];
}

export interface EgressProof {
  from: {
    ref: string;
    placement: string;
    zone: string;
    targetId?: string;
  };
  to: {
    stageId: string;
    inputName: string;
    placement: string;
    zone: string;
    targetId: string;
  };
  transfer: 'cross-target' | 'cross-zone';
  classification: string;
  residencies: readonly string[];
  allowed: true;
  reasons: readonly {
    code:
      | 'classification_zone_allowed'
      | 'classification_trust_satisfied'
      | 'residency_satisfied'
      | 'explicit_declassification_applied';
  }[];
}

export interface ExecutionPlan {
  apiVersion: 'stagefabric.dev/v1alpha1';
  kind: 'ExecutionPlan';
  graphName: string;
  evaluatedAt: string;
  snapshotDigest: string;
  bindingDigest?: string;
  stages: readonly StageExecutionPlan[];
  egress: {
    proofs: readonly EgressProof[];
    digest: string;
  };
  digest: string;
}

/** Detects mutation of a plan after it was produced. This is integrity, not provenance. */
export function verifyExecutionPlanDigest(plan: ExecutionPlan): boolean {
  const { digest, ...unsigned } = plan;
  try {
    return digest === sha256Digest(unsigned);
  } catch {
    return false;
  }
}

export interface PlanRequest {
  fabric: unknown;
  snapshot: unknown;
  graph: unknown;
  evaluatedAt: string;
}

interface Lineage {
  ref: string;
  type: string;
  classification: string;
  residencies: readonly string[];
  declassified: boolean;
  source:
    | { kind: 'input'; origin?: { zone: string; targetId?: string } }
    | { kind: 'stage'; stageId: string };
}

interface EligibleCandidate {
  placement: Placement;
}

function safeIssues(error: {
  issues: readonly {
    code: string;
    path: readonly PropertyKey[];
    message: string;
  }[];
}) {
  return error.issues.map((issue) => ({ code: issue.code }));
}

function parseRequest(request: PlanRequest): {
  fabric: Fabric;
  snapshot: CapabilitySnapshot;
  graph: StageGraph;
  evaluatedAt: string;
  evaluatedEpoch: number;
} {
  const parsedFabric = fabricSchema.safeParse(request.fabric);
  const parsedSnapshot = capabilitySnapshotSchema.safeParse(request.snapshot);
  const parsedGraph = stageGraphSchema.safeParse(request.graph);
  const parsedTime = timestampSchema.safeParse(request.evaluatedAt);
  if (!parsedFabric.success)
    throw new PlannerError('schema_invalid', {
      schema: 'fabric',
      issues: safeIssues(parsedFabric.error),
    });
  if (!parsedSnapshot.success)
    throw new PlannerError('schema_invalid', {
      schema: 'snapshot',
      issues: safeIssues(parsedSnapshot.error),
    });
  if (!parsedGraph.success)
    throw new PlannerError('schema_invalid', {
      schema: 'graph',
      issues: safeIssues(parsedGraph.error),
    });
  if (!parsedTime.success)
    throw new PlannerError('schema_invalid', {
      schema: 'evaluatedAt',
      issues: safeIssues(parsedTime.error),
    });

  return {
    fabric: parsedFabric.data,
    snapshot: parsedSnapshot.data,
    graph: parsedGraph.data,
    evaluatedAt: new Date(Date.parse(parsedTime.data)).toISOString(),
    evaluatedEpoch: Date.parse(parsedTime.data),
  };
}

function codePointSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePointStrings);
}

function assertSnapshot(
  fabric: Fabric,
  snapshot: CapabilitySnapshot,
  evaluatedEpoch: number,
): Map<string, CapabilityTargetState> {
  if (!verifyCapabilitySnapshotDigest(snapshot)) {
    throw new PlannerError('snapshot_digest_mismatch');
  }
  if (evaluatedEpoch < Date.parse(snapshot.observedAt)) {
    throw new PlannerError('snapshot_not_yet_valid', {
      observedAt: snapshot.observedAt,
    });
  }
  if (evaluatedEpoch >= Date.parse(snapshot.expiresAt)) {
    throw new PlannerError('snapshot_expired', {
      expiresAt: snapshot.expiresAt,
    });
  }

  const targetIds = new Set(fabric.targets.map((target) => target.id));
  const unknown = snapshot.targets
    .map((target) => target.targetId)
    .filter((targetId) => !targetIds.has(targetId))
    .sort(compareCodePointStrings);
  if (unknown.length > 0) {
    throw new PlannerError('snapshot_unknown_target', { targetIds: unknown });
  }

  return new Map(snapshot.targets.map((state) => [state.targetId, state]));
}

function validateGraphConfiguration(fabric: Fabric, graph: StageGraph): void {
  const classifications = new Set(
    fabric.classifications.map((classification) => classification.id),
  );
  const zones = new Set(fabric.zones.map((zone) => zone.id));

  for (const input of graph.inputs) {
    if (!classifications.has(input.classification)) {
      throw new PlannerError('unknown_classification', {
        classification: input.classification,
        input: input.name,
      });
    }
    if (input.origin !== undefined && !zones.has(input.origin.zone)) {
      throw new PlannerError('unknown_zone', {
        zone: input.origin.zone,
        input: input.name,
      });
    }
  }

  for (const stage of graph.stages) {
    for (const zone of stage.requirements.allowedZones) {
      if (!zones.has(zone)) {
        throw new PlannerError('unknown_zone', { zone, stageId: stage.id });
      }
    }
    const outputs = new Set(stage.outputs.map((output) => output.name));
    for (const output of stage.outputs) {
      if (
        output.classification !== undefined &&
        !classifications.has(output.classification)
      ) {
        throw new PlannerError('unknown_classification', {
          classification: output.classification,
          stageId: stage.id,
          output: output.name,
        });
      }
    }
    for (const rule of stage.declassifications) {
      if (!outputs.has(rule.output)) {
        throw new PlannerError('invalid_declassification', {
          stageId: stage.id,
          output: rule.output,
        });
      }
      if (!classifications.has(rule.toClassification)) {
        throw new PlannerError('unknown_classification', {
          classification: rule.toClassification,
          stageId: stage.id,
          output: rule.output,
        });
      }
    }
  }
}

function stageOrder(graph: StageGraph): Stage[] {
  const inputTypes = new Map(
    graph.inputs.map((input) => [`input.${input.name}`, input.type]),
  );
  const stageMap = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const outputTypes = new Map<string, string>();
  for (const stage of graph.stages) {
    for (const output of stage.outputs) {
      outputTypes.set(`${stage.id}.${output.name}`, output.type);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const stage of graph.stages) {
    const stageDependencies = new Set<string>();
    for (const [inputName, binding] of Object.entries(stage.inputs)) {
      const [source] = binding.ref.split('.', 1);
      const sourceType =
        source === 'input'
          ? inputTypes.get(binding.ref)
          : outputTypes.get(binding.ref);
      if (sourceType === undefined) {
        throw new PlannerError('missing_reference', {
          stageId: stage.id,
          input: inputName,
          ref: binding.ref,
        });
      }
      if (sourceType !== binding.type) {
        throw new PlannerError('type_mismatch', {
          stageId: stage.id,
          input: inputName,
          ref: binding.ref,
          expected: binding.type,
          actual: sourceType,
        });
      }
      if (source !== 'input') {
        if (!stageMap.has(source!)) {
          throw new PlannerError('missing_reference', {
            stageId: stage.id,
            input: inputName,
            ref: binding.ref,
          });
        }
        stageDependencies.add(source!);
        const children = dependents.get(source!) ?? new Set<string>();
        children.add(stage.id);
        dependents.set(source!, children);
      }
    }
    dependencies.set(stage.id, stageDependencies);
  }

  const ready = graph.stages
    .filter((stage) => dependencies.get(stage.id)!.size === 0)
    .map((stage) => stage.id)
    .sort(compareCodePointStrings);
  const ordered: Stage[] = [];

  while (ready.length > 0) {
    const stageId = ready.shift()!;
    ordered.push(stageMap.get(stageId)!);
    for (const child of [...(dependents.get(stageId) ?? [])].sort(
      compareCodePointStrings,
    )) {
      const childDependencies = dependencies.get(child)!;
      childDependencies.delete(stageId);
      if (childDependencies.size === 0) {
        ready.push(child);
        ready.sort(compareCodePointStrings);
      }
    }
  }

  if (ordered.length !== graph.stages.length) {
    const cycleStages = graph.stages
      .map((stage) => stage.id)
      .filter((stageId) => dependencies.get(stageId)!.size > 0)
      .sort(compareCodePointStrings);
    throw new PlannerError('cycle_detected', { stageIds: cycleStages });
  }
  return ordered;
}

function highestClassification(
  classifications: readonly Classification[],
): Classification {
  return [...classifications].sort(
    (left, right) =>
      right.rank - left.rank || compareCodePointStrings(left.id, right.id),
  )[0]!;
}

function comparePlacements(
  left: EligibleCandidate,
  right: EligibleCandidate,
): number {
  const leftRank = left.placement.rank;
  const rightRank = right.placement.rank;
  return (
    leftRank.zonePreference - rightRank.zonePreference ||
    leftRank.expectedP95Ms - rightRank.expectedP95Ms ||
    leftRank.costMicros - rightRank.costMicros ||
    compareCodePointStrings(left.placement.targetId, right.placement.targetId)
  );
}

function evaluateTarget(
  target: FabricTarget,
  fabric: Fabric,
  snapshotState: CapabilityTargetState | undefined,
  evaluatedEpoch: number,
  processingClassification: Classification,
  stage: Stage,
  requiredOperationCapability: string | undefined,
  requiredCapabilities: readonly string[],
  requiredResidencies: readonly string[],
): { candidate?: EligibleCandidate; rejection?: CandidateRejection } {
  const zone = fabric.zones.find((candidate) => candidate.id === target.zone)!;
  const reasons: RejectionReason[] = [];

  if (snapshotState === undefined) {
    reasons.push({ code: 'snapshot_missing' });
  } else {
    if (!snapshotState.healthy) reasons.push({ code: 'snapshot_unhealthy' });
    const observedAt = snapshotState.observedAt ?? '1970-01-01T00:00:00.000Z';
    if (evaluatedEpoch < Date.parse(observedAt))
      reasons.push({ code: 'snapshot_not_yet_observed' });
    if (
      snapshotState.expiresAt !== undefined &&
      evaluatedEpoch >= Date.parse(snapshotState.expiresAt)
    ) {
      reasons.push({ code: 'snapshot_target_expired' });
    }
  }

  if (
    stage.requirements.allowedZones.length > 0 &&
    !stage.requirements.allowedZones.includes(zone.id)
  ) {
    reasons.push({ code: 'stage_zone_disallowed', values: [zone.id] });
  }
  if (
    processingClassification.allowedZones.length > 0 &&
    !processingClassification.allowedZones.includes(zone.id)
  ) {
    reasons.push({
      code: 'classification_zone_disallowed',
      values: [processingClassification.id, zone.id],
    });
  }
  if (
    processingClassification.allowedResidencies.length > 0 &&
    !processingClassification.allowedResidencies.some((residency) =>
      zone.residencies.includes(residency),
    )
  ) {
    reasons.push({
      code: 'classification_residency_disallowed',
      values: [processingClassification.id],
    });
  }
  if (zone.trustLevel < processingClassification.minTrustLevel) {
    reasons.push({
      code: 'trust_too_low',
      expected: processingClassification.minTrustLevel,
      actual: zone.trustLevel,
    });
  }

  const missingResidencies = requiredResidencies.filter(
    (residency) => !zone.residencies.includes(residency),
  );
  if (missingResidencies.length > 0) {
    reasons.push({ code: 'residency_unsupported', values: missingResidencies });
  }

  const configuredCapabilities = new Set(target.capabilities);
  const missingConfigured = requiredCapabilities.filter(
    (capability) => !configuredCapabilities.has(capability),
  );
  if (missingConfigured.length > 0) {
    reasons.push({
      code: 'capability_not_configured',
      values: missingConfigured,
    });
  }
  if (snapshotState !== undefined) {
    const observedCapabilities = new Set(snapshotState.capabilities);
    if (
      requiredOperationCapability !== undefined &&
      !observedCapabilities.has(requiredOperationCapability)
    ) {
      reasons.push({ code: 'operation_unavailable' });
    }
    const unavailable = requiredCapabilities.filter(
      (capability) => !observedCapabilities.has(capability),
    );
    if (unavailable.length > 0) {
      reasons.push({ code: 'capability_unavailable', values: unavailable });
    }
  }

  if (reasons.length > 0)
    return { rejection: { targetId: target.id, reasons } };

  const zonePreference = fabric.policy.zonePreference.indexOf(zone.id);
  return {
    candidate: {
      placement: {
        targetId: target.id,
        zone: zone.id,
        adapterKind: target.adapter.kind,
        rank: {
          zonePreference:
            zonePreference === -1
              ? fabric.policy.zonePreference.length
              : zonePreference,
          expectedP95Ms: snapshotState?.expectedP95Ms ?? target.expectedP95Ms,
          costMicros: snapshotState?.costMicros ?? target.costMicros,
        },
      },
    },
  };
}

function placementVariants(
  plan: StageExecutionPlan,
): { placement: string; value: Placement }[] {
  return [
    { placement: 'primary', value: plan.primary },
    ...plan.fallbacks.map((value, index) => ({
      placement: `fallback:${index + 1}`,
      value,
    })),
  ];
}

function buildEgressProofs(
  plans: readonly StageExecutionPlan[],
  lineages: ReadonlyMap<string, Lineage>,
): EgressProof[] {
  const planByStage = new Map(plans.map((plan) => [plan.stageId, plan]));
  const proofs: EgressProof[] = [];

  for (const destinationPlan of plans) {
    for (const input of destinationPlan.inputs) {
      const lineage = lineages.get(input.ref)!;
      const sources =
        lineage.source.kind === 'stage'
          ? placementVariants(planByStage.get(lineage.source.stageId)!).map(
              ({ placement, value }) => ({
                placement,
                zone: value.zone,
                targetId: value.targetId,
              }),
            )
          : lineage.source.origin === undefined
            ? []
            : [{ placement: 'input', ...lineage.source.origin }];

      for (const source of sources) {
        for (const destination of placementVariants(destinationPlan)) {
          const crossZone = source.zone !== destination.value.zone;
          const crossTarget =
            source.targetId === undefined ||
            source.targetId !== destination.value.targetId;
          if (!crossZone && !crossTarget) continue;

          const reasons: EgressProof['reasons'] = [
            { code: 'classification_zone_allowed' },
            { code: 'classification_trust_satisfied' },
            { code: 'residency_satisfied' },
            ...(lineage.declassified
              ? ([{ code: 'explicit_declassification_applied' }] as const)
              : []),
          ];
          proofs.push({
            from: {
              ref: lineage.ref,
              placement: source.placement,
              zone: source.zone,
              ...(source.targetId === undefined
                ? {}
                : { targetId: source.targetId }),
            },
            to: {
              stageId: destinationPlan.stageId,
              inputName: input.name,
              placement: destination.placement,
              zone: destination.value.zone,
              targetId: destination.value.targetId,
            },
            transfer: crossZone ? 'cross-zone' : 'cross-target',
            classification: lineage.classification,
            residencies: lineage.residencies,
            allowed: true,
            reasons,
          });
        }
      }
    }
  }

  return proofs.sort((left, right) => {
    const leftKey = `${left.to.stageId}\u0000${left.to.inputName}\u0000${left.from.ref}\u0000${left.from.placement}\u0000${left.to.placement}`;
    const rightKey = `${right.to.stageId}\u0000${right.to.inputName}\u0000${right.from.ref}\u0000${right.from.placement}\u0000${right.to.placement}`;
    return compareCodePointStrings(leftKey, rightKey);
  });
}

export function planStageGraph(request: PlanRequest): ExecutionPlan {
  const { fabric, snapshot, graph, evaluatedAt, evaluatedEpoch } =
    parseRequest(request);
  const snapshotStates = assertSnapshot(fabric, snapshot, evaluatedEpoch);
  validateGraphConfiguration(fabric, graph);
  const orderedStages = stageOrder(graph);
  const classificationById = new Map(
    fabric.classifications.map((classification) => [
      classification.id,
      classification,
    ]),
  );
  const lineages = new Map<string, Lineage>();
  for (const input of graph.inputs) {
    lineages.set(`input.${input.name}`, {
      ref: `input.${input.name}`,
      type: input.type,
      classification: input.classification,
      residencies: codePointSorted(input.residencies),
      declassified: false,
      source: {
        kind: 'input',
        ...(input.origin === undefined
          ? {}
          : {
              origin: {
                zone: input.origin.zone,
                ...(input.origin.targetId === undefined
                  ? {}
                  : { targetId: input.origin.targetId }),
              },
            }),
      },
    });
  }

  const plans: StageExecutionPlan[] = [];
  for (const stage of orderedStages) {
    const inputs = Object.entries(stage.inputs)
      .sort(([left], [right]) => compareCodePointStrings(left, right))
      .map(([name, binding]) => {
        const lineage = lineages.get(binding.ref)!;
        return {
          name,
          ref: binding.ref,
          type: binding.type,
          classification: lineage.classification,
          residencies: lineage.residencies,
        } satisfies PlannedInput;
      });

    const inputClassifications = inputs.map((input) =>
      classificationById.get(input.classification)!,
    );
    const outputDeclaredClassifications = stage.outputs.flatMap((output) => {
      const rule = stage.declassifications.find(
        (candidate) => candidate.output === output.name,
      );
      const id = rule?.toClassification ?? output.classification;
      if (id === undefined) {
        if (inputClassifications.length === 0) {
          throw new PlannerError('classification_required', {
            stageId: stage.id,
            output: output.name,
          });
        }
        return [];
      }
      return [classificationById.get(id)!];
    });
    const processingClassification = highestClassification(
      inputClassifications.length > 0
        ? inputClassifications
        : outputDeclaredClassifications,
    );
    const requiredResidencies = codePointSorted([
      ...stage.requirements.residencies,
      ...inputs.flatMap((input) => input.residencies),
    ]);

    const outputs = [...stage.outputs]
      .sort((left, right) => compareCodePointStrings(left.name, right.name))
      .map((output): PlannedOutput => {
        const rule = stage.declassifications.find(
          (candidate) => candidate.output === output.name,
        );
        if (
          rule !== undefined &&
          output.classification !== undefined &&
          output.classification !== rule.toClassification
        ) {
          throw new PlannerError('invalid_declassification', {
            stageId: stage.id,
            output: output.name,
          });
        }
        const desiredId =
          rule?.toClassification ??
          output.classification ??
          processingClassification.id;
        const desired = classificationById.get(desiredId)!;
        const isDowngrade = desired.rank < processingClassification.rank;
        if (isDowngrade && rule === undefined) {
          throw new PlannerError('declassification_required', {
            stageId: stage.id,
            output: output.name,
            from: processingClassification.id,
            to: desired.id,
          });
        }
        if (rule !== undefined && !isDowngrade) {
          throw new PlannerError('invalid_declassification', {
            stageId: stage.id,
            output: output.name,
          });
        }
        return {
          name: output.name,
          type: output.type,
          classification: desired.id,
          residencies: requiredResidencies,
          ...(rule === undefined
            ? {}
            : {
                declassification: {
                  authorityCapability: rule.authorityCapability,
                  justification: rule.justification,
                },
              }),
        };
      });

    const requiredCapabilities = codePointSorted([
      ...stage.requirements.capabilities,
      ...outputs.flatMap((output) =>
        output.declassification === undefined
          ? []
          : [output.declassification.authorityCapability],
      ),
    ]);
    const eligible: EligibleCandidate[] = [];
    const rejected: CandidateRejection[] = [];
    for (const target of [...fabric.targets].sort((left, right) =>
      compareCodePointStrings(left.id, right.id),
    )) {
      const result = evaluateTarget(
        target,
        fabric,
        snapshotStates.get(target.id),
        evaluatedEpoch,
        processingClassification,
        stage,
        snapshot.bindingDigest === undefined
          ? undefined
          : internalOperationCapability(stage.operation),
        requiredCapabilities,
        requiredResidencies,
      );
      if (result.candidate !== undefined) eligible.push(result.candidate);
      if (result.rejection !== undefined) rejected.push(result.rejection);
    }
    eligible.sort(comparePlacements);
    if (eligible.length === 0) {
      throw new PlannerError('no_eligible_target', {
        stageId: stage.id,
        rejected,
      });
    }

    const plan: StageExecutionPlan = {
      stageId: stage.id,
      operation: stage.operation,
      processingClassification: processingClassification.id,
      requiredCapabilities,
      requiredResidencies,
      inputs,
      outputs,
      primary: eligible[0]!.placement,
      fallbacks: eligible
        .slice(1, 1 + fabric.policy.maxFallbacks)
        .map((candidate) => candidate.placement),
      rejected,
    };
    plans.push(plan);

    for (const output of outputs) {
      lineages.set(`${stage.id}.${output.name}`, {
        ref: `${stage.id}.${output.name}`,
        type: output.type,
        classification: output.classification,
        residencies: output.residencies,
        declassified: output.declassification !== undefined,
        source: { kind: 'stage', stageId: stage.id },
      });
    }
  }

  const proofs = buildEgressProofs(plans, lineages);
  const egress = { proofs, digest: sha256Digest(proofs) };
  const unsigned = {
    apiVersion: 'stagefabric.dev/v1alpha1' as const,
    kind: 'ExecutionPlan' as const,
    graphName: graph.metadata.name,
    evaluatedAt,
    snapshotDigest: snapshot.digest,
    ...(snapshot.bindingDigest === undefined
      ? {}
      : { bindingDigest: snapshot.bindingDigest }),
    stages: plans,
    egress,
  };
  return { ...unsigned, digest: sha256Digest(unsigned) };
}

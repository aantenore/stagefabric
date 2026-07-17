import { OpenAICompatibleStageAdapter } from '../adapters/openai-compatible-stage-adapter.js';
import { probeRuntimeBindings } from '../adapters/openai-compatible-capability-probe.js';
import { StageAdapterRegistry } from '../adapters/stage-adapter-registry.js';
import {
  executePlan,
  type ExecutionResult,
  type ExecutionTraceEvent,
} from '../application/executor.js';
import { planStageGraph, type ExecutionPlan } from '../application/planner.js';
import { compareCodePointStrings } from '../domain/canonical.js';
import {
  runtimeBindingsSchema,
  verifyRuntimeBindingsDigest,
  type RuntimeBindings,
  type RuntimeTargetBinding,
} from '../domain/runtime-bindings.js';
import {
  fabricSchema,
  stageGraphSchema,
  type CapabilitySnapshot,
  type Fabric,
  type StageGraph,
} from '../domain/schema.js';
import type { StageInputGuard } from '../ports/stage-input-guard.js';

export type LiveRunnerErrorCode =
  | 'binding_digest_mismatch'
  | 'binding_target_unknown'
  | 'binding_adapter_mismatch'
  | 'binding_capability_mismatch'
  | 'operation_unbound'
  | 'operation_contract_mismatch'
  | 'live_declassification_unsupported'
  | 'input_contract_mismatch'
  | 'clock_invalid';

/** Content-safe composition error; details contain identifiers, never values. */
export class LiveRunnerError extends Error {
  readonly code: LiveRunnerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LiveRunnerErrorCode,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'LiveRunnerError';
    this.code = code;
    this.details = details;
  }
}

export interface LiveRunRequest {
  readonly fabric: unknown;
  readonly graph: unknown;
  /** Must already be sealed; the runner never trusts or silently reseals it. */
  readonly bindings: unknown;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface LiveRunnerOptions {
  readonly now?: () => Date;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly guards?: readonly StageInputGuard[];
}

export interface LiveRunResult {
  readonly bindingDigest: string;
  readonly snapshot: CapabilitySnapshot;
  readonly plan: ExecutionPlan;
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

export interface PreparedLiveRunRequest {
  readonly fabric: Fabric;
  readonly graph: StageGraph;
  readonly bindings: RuntimeBindings;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface PreparedLiveExecutionResult {
  readonly execution: ExecutionResult;
  readonly outputs: Readonly<Record<string, unknown>>;
}

function validateBindingTarget(
  target: RuntimeTargetBinding,
  fabricTarget: Fabric['targets'][number] | undefined,
): void {
  if (fabricTarget === undefined) {
    throw new LiveRunnerError('binding_target_unknown', {
      targetId: target.targetId,
    });
  }
  if (fabricTarget.adapter.kind !== 'openai-compatible') {
    throw new LiveRunnerError('binding_adapter_mismatch', {
      targetId: target.targetId,
    });
  }

  const configured = new Set(fabricTarget.capabilities);
  for (const operation of target.operations) {
    const missing = operation.capabilities.filter(
      (capability) => !configured.has(capability),
    );
    if (missing.length > 0) {
      throw new LiveRunnerError('binding_capability_mismatch', {
        targetId: target.targetId,
        operation: operation.operation,
        missingCount: missing.length,
      });
    }
  }
}

function assertOperationContracts(
  graph: StageGraph,
  bindings: RuntimeBindings,
): void {
  for (const stage of graph.stages) {
    const matching = bindings.targets.flatMap((target) =>
      target.operations
        .filter((operation) => operation.operation === stage.operation)
        .map((operation) => ({ targetId: target.targetId, operation })),
    );
    if (matching.length === 0) {
      throw new LiveRunnerError('operation_unbound', {
        stageId: stage.id,
      });
    }

    const stageInputs = Object.keys(stage.inputs);
    const stageOutputs = stage.outputs.map((output) => output.name);
    const stageInput = stage.inputs[stageInputs[0] ?? ''];
    const stageOutput = stage.outputs[0];
    for (const match of matching) {
      const expectedOutputType =
        match.operation.kind === 'embedding' ? 'vector/f32' : 'text/plain';
      if (
        stageInputs.length !== 1 ||
        stageInputs[0] !== match.operation.input ||
        stageInput?.type !== 'text/plain' ||
        stageOutputs.length !== 1 ||
        stageOutputs[0] !== match.operation.output ||
        stageOutput?.type !== expectedOutputType
      ) {
        throw new LiveRunnerError('operation_contract_mismatch', {
          stageId: stage.id,
          targetId: match.targetId,
        });
      }
    }
  }
}

function assertNoLiveDeclassification(graph: StageGraph): void {
  const stage = graph.stages.find(
    (candidate) => candidate.declassifications.length > 0,
  );
  if (stage !== undefined) {
    throw new LiveRunnerError('live_declassification_unsupported', {
      stageId: stage.id,
    });
  }
}

function assertExactInputs(
  graph: StageGraph,
  inputs: Readonly<Record<string, unknown>>,
): void {
  const expected = graph.inputs
    .map((input) => input.name)
    .sort(compareCodePointStrings);
  const actual = Object.keys(inputs).sort(compareCodePointStrings);
  if (
    expected.length !== actual.length ||
    expected.some((name, index) => name !== actual[index])
  ) {
    throw new LiveRunnerError('input_contract_mismatch', {
      expected,
      actualCount: actual.length,
    });
  }
}

export function liveRunnerTimestamp(now: () => Date): string {
  try {
    const value = now();
    if (!Number.isFinite(value.getTime())) throw new Error('invalid');
    return value.toISOString();
  } catch {
    throw new LiveRunnerError('clock_invalid');
  }
}

function leafOutputs(
  plan: ExecutionPlan,
  execution: ExecutionResult,
): Readonly<Record<string, unknown>> {
  const consumed = new Set(
    plan.stages.flatMap((stage) => stage.inputs.map((input) => input.ref)),
  );
  const outputs: Record<string, unknown> = {};
  for (const stage of plan.stages) {
    for (const output of stage.outputs) {
      const ref = `${stage.stageId}.${output.name}`;
      if (!consumed.has(ref)) outputs[ref] = execution.values[ref];
    }
  }
  return outputs;
}

export function prepareLiveRunRequest(
  request: LiveRunRequest,
): PreparedLiveRunRequest {
  const fabric = fabricSchema.parse(request.fabric);
  const graph = stageGraphSchema.parse(request.graph);
  const bindings = runtimeBindingsSchema.parse(request.bindings);
  if (!verifyRuntimeBindingsDigest(bindings)) {
    throw new LiveRunnerError('binding_digest_mismatch');
  }

  const fabricTargets = new Map(
    fabric.targets.map((target) => [target.id, target]),
  );
  for (const target of bindings.targets) {
    validateBindingTarget(target, fabricTargets.get(target.targetId));
  }
  assertNoLiveDeclassification(graph);
  assertOperationContracts(graph, bindings);
  assertExactInputs(graph, request.inputs);
  return { fabric, graph, bindings, inputs: request.inputs };
}

export async function observePreparedLiveRuntime(
  request: PreparedLiveRunRequest,
  options: Pick<LiveRunnerOptions, 'environment' | 'fetch' | 'now'> = {},
): Promise<CapabilitySnapshot> {
  const environment = options.environment ?? process.env;
  return probeRuntimeBindings({
    bindings: request.bindings,
    observedAt: liveRunnerTimestamp(options.now ?? (() => new Date())),
    fetch: options.fetch ?? globalThis.fetch,
    resolveBearerToken: ({ apiKeyEnv }) => environment[apiKeyEnv],
  });
}

export async function observeLiveRuntime(
  request: LiveRunRequest,
  options: Pick<LiveRunnerOptions, 'environment' | 'fetch' | 'now'> = {},
): Promise<CapabilitySnapshot> {
  return observePreparedLiveRuntime(prepareLiveRunRequest(request), options);
}

/** Starts credential/provider work. Authenticated callers must fence first. */
export async function executePreparedLivePlan(
  request: PreparedLiveRunRequest,
  plan: ExecutionPlan,
  options: Pick<LiveRunnerOptions, 'environment' | 'fetch' | 'guards'> = {},
): Promise<PreparedLiveExecutionResult> {
  const adapter = new OpenAICompatibleStageAdapter({
    bindings: request.bindings,
    environment: options.environment ?? process.env,
    fetch: options.fetch ?? globalThis.fetch,
  });
  const adapters = new StageAdapterRegistry([adapter], {
    bindingDigest: request.bindings.digest,
  });
  const execution = await executePlan({
    plan,
    inputs: request.inputs,
    adapters,
    ...(options.guards === undefined ? {} : { guards: options.guards }),
  });
  return { execution, outputs: leafOutputs(plan, execution) };
}

/** Executes one same-process live probe → plan → binding-verified run. */
export async function runLiveStageGraph(
  request: LiveRunRequest,
  options: LiveRunnerOptions = {},
): Promise<LiveRunResult> {
  const prepared = prepareLiveRunRequest(request);
  const snapshot = await observePreparedLiveRuntime(prepared, options);
  const evaluatedAt = liveRunnerTimestamp(options.now ?? (() => new Date()));
  const plan = planStageGraph({
    fabric: prepared.fabric,
    graph: prepared.graph,
    snapshot,
    evaluatedAt,
  });
  const { execution, outputs } = await executePreparedLivePlan(
    prepared,
    plan,
    options,
  );

  return {
    bindingDigest: prepared.bindings.digest,
    snapshot,
    plan,
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

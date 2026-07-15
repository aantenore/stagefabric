import {
  verifyExecutionPlanDigest,
  type ExecutionPlan,
  type Placement,
  type StageExecutionPlan,
} from './planner.js';
import {
  StageAdapterError,
  type StageAdapterResolver,
  type StageAdapterRequest,
} from '../ports/stage-adapter.js';
import {
  StageInputPolicyError,
  type StageInputGuard,
} from '../ports/stage-input-guard.js';
import { canonicalJson } from '../domain/canonical.js';

const RETRYABLE_PRE_OUTPUT_STATUSES = new Set([429, 502, 503, 504]);

export type ExecutionFailureCode =
  | 'plan_digest_mismatch'
  | 'binding_digest_mismatch'
  | 'missing_input'
  | 'adapter_not_registered'
  | 'adapter_failed'
  | 'invalid_outputs'
  | 'input_policy_rejected';

export type ExecutionTraceReasonCode =
  | 'completed'
  | 'retryable_pre_output_status'
  | 'adapter_not_registered'
  | 'adapter_failed'
  | 'invalid_outputs'
  | 'input_policy_rejected';

export interface ExecutionTraceEvent {
  readonly stageId: string;
  readonly targetId: string;
  readonly zone: string;
  readonly adapterKind: string;
  readonly attempt: number;
  readonly outcome: 'succeeded' | 'failed';
  readonly reasonCode: ExecutionTraceReasonCode;
  readonly statusCode?: number;
}

export class ExecutionError extends Error {
  readonly code: ExecutionFailureCode;
  readonly stageId: string | undefined;
  readonly trace: readonly ExecutionTraceEvent[];
  readonly reasonCode: string | undefined;

  constructor(options: {
    code: ExecutionFailureCode;
    stageId?: string;
    trace: readonly ExecutionTraceEvent[];
    reasonCode?: string;
  }) {
    super(options.code);
    this.name = 'ExecutionError';
    this.code = options.code;
    this.stageId = options.stageId;
    this.trace = options.trace;
    this.reasonCode = options.reasonCode;
  }
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

/** Captures a plain immutable plan before any user-supplied async code runs. */
function immutablePlanSnapshot(plan: ExecutionPlan): ExecutionPlan {
  let snapshot: ExecutionPlan;
  try {
    snapshot = JSON.parse(canonicalJson(plan)) as ExecutionPlan;
  } catch {
    throw new ExecutionError({ code: 'plan_digest_mismatch', trace: [] });
  }
  if (!verifyExecutionPlanDigest(snapshot)) {
    throw new ExecutionError({ code: 'plan_digest_mismatch', trace: [] });
  }
  return deepFreeze(snapshot);
}

export interface ExecutePlanRequest {
  readonly plan: ExecutionPlan;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly adapters: StageAdapterResolver;
  readonly guards?: readonly StageInputGuard[];
}

export interface StageExecutionRecord {
  readonly stageId: string;
  readonly targetId: string;
  readonly zone: string;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface ExecutionResult {
  readonly planDigest: string;
  readonly stages: readonly StageExecutionRecord[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly trace: readonly ExecutionTraceEvent[];
}

function placements(stage: StageExecutionPlan): readonly Placement[] {
  return [stage.primary, ...stage.fallbacks];
}

function traceEvent(
  stage: StageExecutionPlan,
  placement: Placement,
  attempt: number,
  outcome: ExecutionTraceEvent['outcome'],
  reasonCode: ExecutionTraceReasonCode,
  statusCode?: number,
): ExecutionTraceEvent {
  return {
    stageId: stage.stageId,
    targetId: placement.targetId,
    zone: placement.zone,
    adapterKind: placement.adapterKind,
    attempt,
    outcome,
    reasonCode,
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function assertExactOutputs(
  stage: StageExecutionPlan,
  outputs: Readonly<Record<string, unknown>>,
): void {
  const expected = stage.outputs.map((output) => output.name).sort();
  const actual = Object.keys(outputs).sort();
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error('invalid_outputs');
  }
}

function stageInputs(
  stage: StageExecutionPlan,
  values: ReadonlyMap<string, unknown>,
  trace: readonly ExecutionTraceEvent[],
): Readonly<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {};
  for (const input of stage.inputs) {
    if (!values.has(input.ref)) {
      throw new ExecutionError({
        code: 'missing_input',
        stageId: stage.stageId,
        trace,
        reasonCode: input.ref,
      });
    }
    inputs[input.name] = values.get(input.ref);
  }
  return inputs;
}

function canFallback(
  error: unknown,
): error is StageAdapterError & { statusCode: number } {
  return (
    error instanceof StageAdapterError &&
    error.outputEmitted === false &&
    error.statusCode !== undefined &&
    RETRYABLE_PRE_OUTPUT_STATUSES.has(error.statusCode)
  );
}

/** Executes the planner's already bounded, topologically ordered stage list. */
export async function executePlan(
  request: ExecutePlanRequest,
): Promise<ExecutionResult> {
  const plan = immutablePlanSnapshot(request.plan);
  const adapters = request.adapters;
  const guards = Object.freeze([...(request.guards ?? [])]);
  if (plan.bindingDigest !== adapters.bindingDigest) {
    throw new ExecutionError({
      code: 'binding_digest_mismatch',
      trace: [],
    });
  }

  const values = new Map<string, unknown>(
    Object.entries(request.inputs).map(([name, value]) => [
      `input.${name}`,
      value,
    ]),
  );
  const trace: ExecutionTraceEvent[] = [];
  const records: StageExecutionRecord[] = [];

  for (const stage of plan.stages) {
    const inputs = Object.freeze(stageInputs(stage, values, trace));
    const candidates = Object.freeze(placements(stage));
    let completed = false;

    for (const [index, placement] of candidates.entries()) {
      const attempt = index + 1;
      const adapter = adapters.get(placement.adapterKind);
      if (adapter === undefined) {
        trace.push(
          traceEvent(
            stage,
            placement,
            attempt,
            'failed',
            'adapter_not_registered',
          ),
        );
        throw new ExecutionError({
          code: 'adapter_not_registered',
          stageId: stage.stageId,
          trace,
          reasonCode: placement.adapterKind,
        });
      }

      try {
        for (const guard of guards) {
          await guard.inspect({
            stageId: stage.stageId,
            operation: stage.operation,
            placement,
            inputs,
          });
        }
      } catch (error) {
        const reasonCode =
          error instanceof StageInputPolicyError
            ? error.reasonCode
            : 'guard_failed';
        trace.push(
          traceEvent(
            stage,
            placement,
            attempt,
            'failed',
            'input_policy_rejected',
          ),
        );
        throw new ExecutionError({
          code: 'input_policy_rejected',
          stageId: stage.stageId,
          trace,
          reasonCode,
        });
      }

      const adapterRequest: StageAdapterRequest = {
        stageId: stage.stageId,
        operation: stage.operation,
        targetId: placement.targetId,
        zone: placement.zone,
        inputs,
        expectedOutputs: stage.outputs.map((output) => output.name),
      };

      try {
        const result = await adapter.execute(adapterRequest);
        try {
          assertExactOutputs(stage, result.outputs);
        } catch {
          trace.push(
            traceEvent(stage, placement, attempt, 'failed', 'invalid_outputs'),
          );
          throw new ExecutionError({
            code: 'invalid_outputs',
            stageId: stage.stageId,
            trace,
          });
        }
        for (const output of stage.outputs) {
          values.set(
            `${stage.stageId}.${output.name}`,
            result.outputs[output.name],
          );
        }
        records.push({
          stageId: stage.stageId,
          targetId: placement.targetId,
          zone: placement.zone,
          outputs: result.outputs,
        });
        trace.push(
          traceEvent(stage, placement, attempt, 'succeeded', 'completed'),
        );
        completed = true;
        break;
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        if (canFallback(error)) {
          trace.push(
            traceEvent(
              stage,
              placement,
              attempt,
              'failed',
              'retryable_pre_output_status',
              error.statusCode,
            ),
          );
          if (index + 1 < candidates.length) continue;
        } else {
          trace.push(
            traceEvent(stage, placement, attempt, 'failed', 'adapter_failed'),
          );
        }
        throw new ExecutionError({
          code: 'adapter_failed',
          stageId: stage.stageId,
          trace,
          reasonCode:
            error instanceof StageAdapterError
              ? error.code
              : 'unexpected_adapter_failure',
        });
      }
    }

    if (!completed) {
      throw new ExecutionError({
        code: 'adapter_failed',
        stageId: stage.stageId,
        trace,
      });
    }
  }

  return {
    planDigest: plan.digest,
    stages: records,
    values: Object.fromEntries(values),
    trace,
  };
}

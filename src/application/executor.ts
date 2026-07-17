import {
  verifyExecutionPlanDigest,
  type ExecutionPlan,
  type Placement,
  type StageExecutionPlan,
} from './planner.js';
import {
  isStageAdapterError,
  type StageAdapterError,
  type StageAdapterResolver,
  type StageAdapterRequest,
} from '../ports/stage-adapter.js';
import {
  isStageInputPolicyError,
  type StageInputGuard,
} from '../ports/stage-input-guard.js';
import {
  isStageOutputVerificationError,
  StageOutputVerificationError,
  type StageOutputVerifier,
} from '../ports/stage-output-verifier.js';
import { canonicalJson } from '../domain/canonical.js';

const RETRYABLE_PRE_OUTPUT_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_SNAPSHOT_MAX_DEPTH = 64;
const DEFAULT_SNAPSHOT_MAX_NODES = 50_000;

export type ExecutionFailureCode =
  | 'plan_digest_mismatch'
  | 'binding_digest_mismatch'
  | 'missing_input'
  | 'adapter_not_registered'
  | 'adapter_failed'
  | 'invalid_outputs'
  | 'input_policy_rejected'
  | 'output_policy_rejected';

export type ExecutionTraceReasonCode =
  | 'completed'
  | 'retryable_pre_output_status'
  | 'adapter_not_registered'
  | 'adapter_failed'
  | 'invalid_outputs'
  | 'input_policy_rejected'
  | 'output_policy_rejected';

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

interface ExecutionErrorOptions {
  readonly code: ExecutionFailureCode;
  readonly stageId?: string;
  readonly trace: readonly ExecutionTraceEvent[];
  readonly reasonCode?: string;
}

const EXECUTION_ERROR_AUTHORITY = Symbol('stagefabric.execution-error');
const executionErrors = new WeakSet<object>();

export class ExecutionError extends Error {
  readonly code: ExecutionFailureCode;
  readonly stageId: string | undefined;
  readonly trace: readonly ExecutionTraceEvent[];
  readonly reasonCode: string | undefined;

  protected constructor(options: ExecutionErrorOptions, authority: symbol) {
    if (authority !== EXECUTION_ERROR_AUTHORITY) {
      throw new TypeError('execution_error_constructor_private');
    }
    super(options.code);
    this.name = 'ExecutionError';
    this.code = options.code;
    this.stageId = options.stageId;
    this.trace = options.trace;
    this.reasonCode = options.reasonCode;
    executionErrors.add(this);
  }
}

class InternalExecutionError extends ExecutionError {
  constructor(options: ExecutionErrorOptions) {
    super(options, EXECUTION_ERROR_AUTHORITY);
  }
}

function executionError(options: ExecutionErrorOptions): ExecutionError {
  return new InternalExecutionError(options);
}

export function isExecutionError(value: unknown): value is ExecutionError {
  return (
    typeof value === 'object' && value !== null && executionErrors.has(value)
  );
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

class ExecutionDataSnapshotError extends Error {}

export interface ExecutionSnapshotLimits {
  /** Maximum nesting depth, including the root at depth zero. */
  readonly maxDepth?: number;
  /** Maximum number of primitive and container nodes in one snapshot. */
  readonly maxNodes?: number;
}

interface ResolvedExecutionSnapshotLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new ExecutionDataSnapshotError();
  }
  return candidate;
}

function resolveSnapshotLimits(
  limits: ExecutionSnapshotLimits | undefined,
): ResolvedExecutionSnapshotLimits {
  return {
    maxDepth: positiveInteger(limits?.maxDepth, DEFAULT_SNAPSHOT_MAX_DEPTH),
    maxNodes: positiveInteger(limits?.maxNodes, DEFAULT_SNAPSHOT_MAX_NODES),
  };
}

function arrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

/**
 * Copies plain structured execution data without invoking accessors. Supported
 * primitives are null, string, number, boolean, undefined and bigint; arrays
 * and plain objects may contain those values recursively. Exotic prototypes,
 * symbols, functions, accessors and cycles fail closed. Shared subtrees are
 * copied independently so aliases cannot carry mutations across a request.
 */
function cloneExecutionData(
  value: unknown,
  limits: ResolvedExecutionSnapshotLimits,
  budget = { nodes: 0 },
  ancestors = new WeakSet<object>(),
  depth = 0,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > limits.maxNodes || depth > limits.maxDepth) {
    throw new ExecutionDataSnapshotError();
  }

  if (value === null) return value;
  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean' ||
    valueType === 'undefined' ||
    valueType === 'bigint'
  ) {
    return value;
  }
  if (valueType !== 'object') throw new ExecutionDataSnapshotError();

  const object = value as object;
  if (ancestors.has(object)) throw new ExecutionDataSnapshotError();
  ancestors.add(object);
  try {
    const prototype = Object.getPrototypeOf(object);
    const descriptors = Object.getOwnPropertyDescriptors(object);

    if (Array.isArray(object)) {
      if (prototype !== Array.prototype) throw new ExecutionDataSnapshotError();
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new ExecutionDataSnapshotError();
      }
      const length = lengthDescriptor.value as number;
      if (length > limits.maxNodes - budget.nodes) {
        throw new ExecutionDataSnapshotError();
      }
      const clone: unknown[] = [];
      clone.length = length;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !arrayIndex(key, length)) {
          throw new ExecutionDataSnapshotError();
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new ExecutionDataSnapshotError();
        }
        Object.defineProperty(clone, key, {
          value: cloneExecutionData(
            descriptor.value,
            limits,
            budget,
            ancestors,
            depth + 1,
          ),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return clone;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw new ExecutionDataSnapshotError();
    }
    const clone: Record<PropertyKey, unknown> =
      prototype === null ? Object.create(null) : {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new ExecutionDataSnapshotError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new ExecutionDataSnapshotError();
      }
      Object.defineProperty(clone, key, {
        value: cloneExecutionData(
          descriptor.value,
          limits,
          budget,
          ancestors,
          depth + 1,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } catch (error) {
    if (error instanceof ExecutionDataSnapshotError) throw error;
    throw new ExecutionDataSnapshotError();
  } finally {
    ancestors.delete(object);
  }
}

function executionRecordSnapshot(
  value: unknown,
  limits: ResolvedExecutionSnapshotLimits,
): Readonly<Record<string, unknown>> {
  const snapshot = cloneExecutionData(value, limits);
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot)
  ) {
    throw new ExecutionDataSnapshotError();
  }
  return snapshot as Readonly<Record<string, unknown>>;
}

function immutableExecutionRecordSnapshot(
  value: unknown,
  limits: ResolvedExecutionSnapshotLimits,
): Readonly<Record<string, unknown>> {
  return deepFreeze(executionRecordSnapshot(value, limits));
}

function adapterOutputsSnapshot(
  result: unknown,
  limits: ResolvedExecutionSnapshotLimits,
): Readonly<Record<string, unknown>> {
  const resultSnapshot = executionRecordSnapshot(result, limits);
  if (!Object.hasOwn(resultSnapshot, 'outputs')) {
    throw new ExecutionDataSnapshotError();
  }
  return immutableExecutionRecordSnapshot(resultSnapshot.outputs, limits);
}

/** Captures a plain immutable plan before any user-supplied async code runs. */
function immutablePlanSnapshot(plan: ExecutionPlan): ExecutionPlan {
  let snapshot: ExecutionPlan;
  try {
    snapshot = JSON.parse(canonicalJson(plan)) as ExecutionPlan;
  } catch {
    throw executionError({ code: 'plan_digest_mismatch', trace: [] });
  }
  if (!verifyExecutionPlanDigest(snapshot)) {
    throw executionError({ code: 'plan_digest_mismatch', trace: [] });
  }
  return deepFreeze(snapshot);
}

export interface ExecutePlanRequest {
  readonly plan: ExecutionPlan;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly adapters: StageAdapterResolver;
  readonly guards?: readonly StageInputGuard[];
  readonly outputVerifier?: StageOutputVerifier;
  readonly snapshotLimits?: ExecutionSnapshotLimits;
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

interface CapturedStageInputGuard {
  readonly receiver: StageInputGuard;
  readonly inspect: StageInputGuard['inspect'];
}

function captureStageInputGuards(
  guards: readonly StageInputGuard[] | undefined,
): readonly CapturedStageInputGuard[] {
  try {
    return Object.freeze(
      [...(guards ?? [])].map((guard) => {
        const inspect = guard.inspect;
        if (typeof inspect !== 'function') {
          throw new TypeError('stage_input_guard_invalid');
        }
        return Object.freeze({ receiver: guard, inspect });
      }),
    );
  } catch {
    throw executionError({
      code: 'input_policy_rejected',
      trace: [],
      reasonCode: 'guard_failed',
    });
  }
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
      throw executionError({
        code: 'missing_input',
        stageId: stage.stageId,
        trace,
        reasonCode: input.ref,
      });
    }
    Object.defineProperty(inputs, input.name, {
      value: values.get(input.ref),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return inputs;
}

function canFallback(
  error: unknown,
): error is StageAdapterError & { statusCode: number } {
  return (
    isStageAdapterError(error) &&
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
  let snapshotLimits: ResolvedExecutionSnapshotLimits;
  let initialInputs: Readonly<Record<string, unknown>>;
  try {
    snapshotLimits = resolveSnapshotLimits(request.snapshotLimits);
    initialInputs = immutableExecutionRecordSnapshot(
      request.inputs,
      snapshotLimits,
    );
  } catch {
    throw executionError({
      code: 'input_policy_rejected',
      trace: [],
      reasonCode: 'input_snapshot_invalid',
    });
  }
  const adapters = request.adapters;
  const guards = captureStageInputGuards(request.guards);
  const outputVerifier = request.outputVerifier;
  let verifyOutput: StageOutputVerifier['verify'] | undefined;
  let outputVerifierInvalid = false;
  if (outputVerifier !== undefined) {
    try {
      verifyOutput = outputVerifier.verify;
      if (typeof verifyOutput !== 'function') {
        outputVerifierInvalid = true;
        verifyOutput = undefined;
      }
    } catch {
      outputVerifierInvalid = true;
    }
  }
  if (plan.bindingDigest !== adapters.bindingDigest) {
    throw executionError({
      code: 'binding_digest_mismatch',
      trace: [],
    });
  }

  const values = new Map<string, unknown>(
    Object.entries(initialInputs).map(([name, value]) => [
      `input.${name}`,
      value,
    ]),
  );
  const trace: ExecutionTraceEvent[] = [];
  const records: StageExecutionRecord[] = [];

  for (const stage of plan.stages) {
    let inputs: Readonly<Record<string, unknown>>;
    try {
      inputs = immutableExecutionRecordSnapshot(
        stageInputs(stage, values, trace),
        snapshotLimits,
      );
    } catch (error) {
      if (isExecutionError(error)) throw error;
      throw executionError({
        code: 'input_policy_rejected',
        stageId: stage.stageId,
        trace,
        reasonCode: 'input_snapshot_invalid',
      });
    }
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
        throw executionError({
          code: 'adapter_not_registered',
          stageId: stage.stageId,
          trace,
          reasonCode: placement.adapterKind,
        });
      }

      try {
        for (const { receiver, inspect } of guards) {
          await Reflect.apply(inspect, receiver, [
            {
              stageId: stage.stageId,
              operation: stage.operation,
              placement,
              inputs: executionRecordSnapshot(inputs, snapshotLimits),
            },
          ]);
        }
      } catch (error) {
        const reasonCode = isStageInputPolicyError(error)
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
        throw executionError({
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
        inputs: executionRecordSnapshot(inputs, snapshotLimits),
        expectedOutputs: Object.freeze(
          stage.outputs.map((output) => output.name),
        ),
      };

      try {
        const result = await adapter.execute(adapterRequest);
        let outputs: Readonly<Record<string, unknown>>;
        try {
          outputs = adapterOutputsSnapshot(result, snapshotLimits);
          assertExactOutputs(stage, outputs);
        } catch {
          trace.push(
            traceEvent(stage, placement, attempt, 'failed', 'invalid_outputs'),
          );
          throw executionError({
            code: 'invalid_outputs',
            stageId: stage.stageId,
            trace,
          });
        }

        for (const output of stage.outputs) {
          if (output.declassification === undefined) continue;
          if (outputVerifier === undefined || verifyOutput === undefined) {
            trace.push(
              traceEvent(
                stage,
                placement,
                attempt,
                'failed',
                'output_policy_rejected',
              ),
            );
            throw executionError({
              code: 'output_policy_rejected',
              stageId: stage.stageId,
              trace,
              reasonCode: outputVerifierInvalid
                ? 'output_verifier_failed'
                : 'declassification_verifier_missing',
            });
          }
          try {
            const verified = await Reflect.apply(verifyOutput, outputVerifier, [
              {
                stageId: stage.stageId,
                operation: stage.operation,
                placement,
                inputs: executionRecordSnapshot(inputs, snapshotLimits),
                output: Object.freeze({
                  name: output.name,
                  type: output.type,
                  fromClassification: stage.processingClassification,
                  classification: output.classification,
                  authorityCapability:
                    output.declassification.authorityCapability,
                  justification: output.declassification.justification,
                }),
                value: cloneExecutionData(outputs[output.name], snapshotLimits),
              },
            ]);
            if (verified !== true) {
              throw new StageOutputVerificationError(
                'declassification_verification_failed',
              );
            }
          } catch (error) {
            trace.push(
              traceEvent(
                stage,
                placement,
                attempt,
                'failed',
                'output_policy_rejected',
              ),
            );
            throw executionError({
              code: 'output_policy_rejected',
              stageId: stage.stageId,
              trace,
              reasonCode: isStageOutputVerificationError(error)
                ? error.reasonCode
                : 'output_verifier_failed',
            });
          }
        }

        for (const output of stage.outputs) {
          values.set(`${stage.stageId}.${output.name}`, outputs[output.name]);
        }
        records.push({
          stageId: stage.stageId,
          targetId: placement.targetId,
          zone: placement.zone,
          outputs,
        });
        trace.push(
          traceEvent(stage, placement, attempt, 'succeeded', 'completed'),
        );
        completed = true;
        break;
      } catch (error) {
        if (isExecutionError(error)) throw error;
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
        throw executionError({
          code: 'adapter_failed',
          stageId: stage.stageId,
          trace,
          reasonCode: isStageAdapterError(error)
            ? error.code
            : 'unexpected_adapter_failure',
        });
      }
    }

    if (!completed) {
      throw executionError({
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

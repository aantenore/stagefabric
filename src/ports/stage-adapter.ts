export interface StageAdapterRequest {
  readonly stageId: string;
  readonly operation: string;
  readonly targetId: string;
  readonly zone: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly expectedOutputs: readonly string[];
}

export interface StageAdapterResult {
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface StageAdapter {
  readonly kind: string;
  execute(request: StageAdapterRequest): Promise<StageAdapterResult>;
}

/** Application-facing lookup port implemented by composition-layer registries. */
export interface StageAdapterResolver {
  /**
   * Digest of the trusted runtime bindings represented by this resolver.
   * It is intentionally absent for unbound/in-process adapters.
   */
  readonly bindingDigest: string | undefined;
  get(kind: string): StageAdapter | undefined;
}

export type StageAdapterFailureCode =
  | 'upstream_rejected'
  | 'upstream_unavailable'
  | 'timeout'
  | 'partial_output'
  | 'adapter_failure';

export const STAGE_ADAPTER_FAILURE_CODES = [
  'upstream_rejected',
  'upstream_unavailable',
  'timeout',
  'partial_output',
  'adapter_failure',
] as const satisfies readonly StageAdapterFailureCode[];

const STAGE_ADAPTER_FAILURE_CODE_SET = new Set<string>(
  STAGE_ADAPTER_FAILURE_CODES,
);
const stageAdapterErrors = new WeakSet<object>();

export interface StageAdapterErrorOptions {
  readonly code: StageAdapterFailureCode;
  readonly statusCode?: number;
  readonly outputEmitted?: boolean;
}

/**
 * A deliberately small, structured adapter failure. The executor never emits
 * this error's message or cause into traces.
 */
export class StageAdapterError extends Error {
  readonly code: StageAdapterFailureCode;
  readonly statusCode: number | undefined;
  readonly outputEmitted: boolean;

  constructor(options: StageAdapterErrorOptions) {
    let code: StageAdapterFailureCode;
    let statusCode: number | undefined;
    let outputEmitted: boolean | undefined;
    try {
      code = options.code;
      statusCode = options.statusCode;
      outputEmitted = options.outputEmitted;
    } catch {
      throw new TypeError('stage_adapter_error_invalid');
    }
    if (
      !STAGE_ADAPTER_FAILURE_CODE_SET.has(code) ||
      (statusCode !== undefined &&
        (!Number.isInteger(statusCode) ||
          statusCode < 100 ||
          statusCode > 599)) ||
      (outputEmitted !== undefined && typeof outputEmitted !== 'boolean')
    ) {
      throw new TypeError('stage_adapter_error_invalid');
    }
    super(code);
    this.name = 'StageAdapterError';
    this.code = code;
    this.statusCode = statusCode;
    this.outputEmitted = outputEmitted ?? false;
    stageAdapterErrors.add(this);
    Object.freeze(this);
  }
}

export function isStageAdapterError(
  value: unknown,
): value is StageAdapterError {
  return (
    typeof value === 'object' && value !== null && stageAdapterErrors.has(value)
  );
}

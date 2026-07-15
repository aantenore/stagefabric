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
    super(options.code);
    this.name = 'StageAdapterError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.outputEmitted = options.outputEmitted ?? false;
  }
}

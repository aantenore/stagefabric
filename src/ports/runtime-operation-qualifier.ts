import type {
  RuntimeBindingsPolicy,
  RuntimeOperationBinding,
  RuntimeTargetBinding,
} from '../domain/runtime-bindings.js';
import type { RuntimeQualificationReasonCode } from '../domain/runtime-qualification.js';

export interface RuntimeOperationQualification {
  readonly operation: string;
  readonly operationKind: RuntimeOperationBinding['kind'];
  readonly status: 'qualified' | 'rejected';
  readonly reasonCode: RuntimeQualificationReasonCode;
}

export interface RuntimeOperationQualifierRequest {
  readonly target: RuntimeTargetBinding;
  readonly operations: readonly RuntimeOperationBinding[];
  readonly policy: Pick<
    RuntimeBindingsPolicy,
    'requestTimeoutMs' | 'maxResponseBytes'
  > & {
    /** Hard admission ceiling for each synthetic generation call. */
    readonly maxGenerationOutputTokensPerCall: number;
  };
  /** Provider-owned secret resolved by the host; never returned or persisted. */
  readonly credential?: string;
  /** The orchestrator's total deadline. Implementations must forward it to I/O. */
  readonly signal: AbortSignal;
}

/**
 * Qualifies bound operations for exactly one provider target. Implementations
 * are registered by `kind`; configuration can select a kind but never code.
 */
export interface RuntimeOperationQualifier {
  readonly kind: string;
  /** Safe implementation artifact version bound into every report result. */
  readonly version: string;
  qualify(
    request: RuntimeOperationQualifierRequest,
  ): Promise<readonly RuntimeOperationQualification[]>;
}

export interface RuntimeQualificationCredentialRequest {
  readonly targetId: string;
  readonly providerKind: string;
  readonly providerName: string;
  readonly reference: string;
  /** Total qualification deadline; remote resolvers should abort their I/O. */
  readonly signal: AbortSignal;
}

export type RuntimeQualificationCredentialResolver = (
  request: RuntimeQualificationCredentialRequest,
) => Promise<string | undefined> | string | undefined;

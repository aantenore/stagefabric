export interface OutputVerificationPlacement {
  readonly targetId: string;
  readonly zone: string;
  readonly adapterKind: string;
}

export interface DeclassifiedStageOutput {
  readonly name: string;
  readonly type: string;
  readonly fromClassification: string;
  readonly classification: string;
  readonly authorityCapability: string;
  readonly justification: string;
}

export interface StageOutputVerificationRequest {
  readonly stageId: string;
  readonly operation: string;
  readonly placement: OutputVerificationPlacement;
  /** A disposable, plain-data snapshot. Mutating it cannot affect execution. */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly output: DeclassifiedStageOutput;
  /** A disposable, plain-data snapshot. Mutating it cannot affect execution. */
  readonly value: unknown;
}

/**
 * Trusted application port for validating an explicit declassification.
 * Only the exact boolean `true` authorizes the output; false, undefined and
 * exceptions all fail closed.
 */
export interface StageOutputVerifier {
  verify(request: StageOutputVerificationRequest): boolean | Promise<boolean>;
}

export const STAGE_OUTPUT_VERIFICATION_REASON_CODES = [
  'declassification_verification_failed',
  'output_contract_mismatch',
  'redaction_proof_invalid',
  'sensitive_data_remaining',
  'verifier_policy_unavailable',
] as const;

export type StageOutputVerificationReasonCode =
  (typeof STAGE_OUTPUT_VERIFICATION_REASON_CODES)[number];

const STAGE_OUTPUT_VERIFICATION_REASON_CODE_SET = new Set<string>(
  STAGE_OUTPUT_VERIFICATION_REASON_CODES,
);
const stageOutputVerificationErrors = new WeakSet<object>();

export class StageOutputVerificationError extends Error {
  readonly reasonCode: StageOutputVerificationReasonCode;

  constructor(reasonCode: StageOutputVerificationReasonCode) {
    if (!STAGE_OUTPUT_VERIFICATION_REASON_CODE_SET.has(reasonCode)) {
      throw new TypeError('stage_output_verification_reason_invalid');
    }
    super(reasonCode);
    this.name = 'StageOutputVerificationError';
    this.reasonCode = reasonCode;
    stageOutputVerificationErrors.add(this);
    Object.freeze(this);
  }
}

export function isStageOutputVerificationError(
  value: unknown,
): value is StageOutputVerificationError {
  return (
    typeof value === 'object' &&
    value !== null &&
    stageOutputVerificationErrors.has(value)
  );
}

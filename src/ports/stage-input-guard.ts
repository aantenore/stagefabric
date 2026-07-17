export interface GuardPlacement {
  readonly targetId: string;
  readonly zone: string;
  readonly adapterKind: string;
}

export interface StageInputGuardRequest {
  readonly stageId: string;
  readonly operation: string;
  readonly placement: GuardPlacement;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export interface StageInputGuard {
  inspect(request: StageInputGuardRequest): void | Promise<void>;
}

export const STAGE_INPUT_POLICY_REASON_CODES = [
  'input_contract_mismatch',
  'input_size_exceeded',
  'inspection_cycle_detected',
  'inspection_limit_exceeded',
  'inspection_string_limit_exceeded',
  'inspection_unsafe_value',
  'policy_unavailable',
  'sensitive_data_detected',
] as const;

export type StageInputPolicyReasonCode =
  (typeof STAGE_INPUT_POLICY_REASON_CODES)[number];

const STAGE_INPUT_POLICY_REASON_CODE_SET = new Set<string>(
  STAGE_INPUT_POLICY_REASON_CODES,
);
const stageInputPolicyErrors = new WeakSet<object>();

export class StageInputPolicyError extends Error {
  readonly reasonCode: StageInputPolicyReasonCode;

  constructor(reasonCode: StageInputPolicyReasonCode) {
    if (!STAGE_INPUT_POLICY_REASON_CODE_SET.has(reasonCode)) {
      throw new TypeError('stage_input_policy_reason_invalid');
    }
    super(reasonCode);
    this.name = 'StageInputPolicyError';
    this.reasonCode = reasonCode;
    stageInputPolicyErrors.add(this);
    Object.freeze(this);
  }
}

export function isStageInputPolicyError(
  value: unknown,
): value is StageInputPolicyError {
  return (
    typeof value === 'object' &&
    value !== null &&
    stageInputPolicyErrors.has(value)
  );
}

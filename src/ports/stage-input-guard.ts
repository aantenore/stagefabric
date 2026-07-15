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

export class StageInputPolicyError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = 'StageInputPolicyError';
    this.reasonCode = reasonCode;
  }
}

import {
  StageInputPolicyError,
  type StageInputGuard,
  type StageInputGuardRequest,
} from '../ports/stage-input-guard.js';

export interface SensitiveDataPattern {
  readonly id: string;
  readonly expression: RegExp;
}

export interface SensitiveDataGuardOptions {
  readonly patterns: readonly SensitiveDataPattern[];
  readonly inspectPlacement: (request: StageInputGuardRequest) => boolean;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
}

function containsMatch(
  value: unknown,
  patterns: readonly SensitiveDataPattern[],
  budget: { nodes: number },
  maxNodes: number,
  maxDepth: number,
  depth = 0,
): boolean {
  budget.nodes += 1;
  if (budget.nodes > maxNodes || depth > maxDepth) {
    throw new StageInputPolicyError('inspection_limit_exceeded');
  }
  if (typeof value === 'string') {
    return patterns.some(({ expression }) => {
      expression.lastIndex = 0;
      return expression.test(value);
    });
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsMatch(item, patterns, budget, maxNodes, maxDepth, depth + 1),
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Readonly<Record<string, unknown>>).some(
      (item) =>
        containsMatch(item, patterns, budget, maxNodes, maxDepth, depth + 1),
    );
  }
  return false;
}

export class SensitiveDataGuard implements StageInputGuard {
  readonly #options: Required<
    Pick<SensitiveDataGuardOptions, 'maxNodes' | 'maxDepth'>
  > &
    Omit<SensitiveDataGuardOptions, 'maxNodes' | 'maxDepth'>;

  constructor(options: SensitiveDataGuardOptions) {
    this.#options = {
      ...options,
      maxNodes: options.maxNodes ?? 10_000,
      maxDepth: options.maxDepth ?? 32,
    };
  }

  inspect(request: StageInputGuardRequest): void {
    if (!this.#options.inspectPlacement(request)) return;
    if (
      containsMatch(
        request.inputs,
        this.#options.patterns,
        { nodes: 0 },
        this.#options.maxNodes,
        this.#options.maxDepth,
      )
    ) {
      throw new StageInputPolicyError('sensitive_data_detected');
    }
  }
}

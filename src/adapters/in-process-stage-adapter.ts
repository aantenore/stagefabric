import type {
  StageAdapter,
  StageAdapterRequest,
  StageAdapterResult,
} from '../ports/stage-adapter.js';

export type InProcessStageHandler = (
  request: StageAdapterRequest,
) => StageAdapterResult | Promise<StageAdapterResult>;

/**
 * An explicit handler table for tests, local runtimes, and deterministic demos.
 * Configuration can select this adapter kind, but can never import executable code.
 */
export class InProcessStageAdapter implements StageAdapter {
  readonly kind: string;
  readonly #handlers: ReadonlyMap<string, InProcessStageHandler>;

  constructor(
    kind: string,
    handlers: Readonly<Record<string, InProcessStageHandler>>,
  ) {
    this.kind = kind;
    this.#handlers = new Map(Object.entries(handlers));
  }

  async execute(request: StageAdapterRequest): Promise<StageAdapterResult> {
    const targetSpecific = this.#handlers.get(
      `${request.targetId}:${request.operation}`,
    );
    const handler = targetSpecific ?? this.#handlers.get(request.operation);
    if (handler === undefined) {
      throw new Error('in_process_handler_missing');
    }
    return handler(request);
  }
}

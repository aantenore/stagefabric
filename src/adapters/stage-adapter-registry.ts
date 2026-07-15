import type {
  StageAdapter,
  StageAdapterResolver,
} from '../ports/stage-adapter.js';

export class StageAdapterRegistry implements StageAdapterResolver {
  readonly #adapters = new Map<string, StageAdapter>();

  constructor(adapters: readonly StageAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: StageAdapter): this {
    if (this.#adapters.has(adapter.kind)) {
      throw new Error(`adapter kind already registered: ${adapter.kind}`);
    }
    this.#adapters.set(adapter.kind, adapter);
    return this;
  }

  get(kind: string): StageAdapter | undefined {
    return this.#adapters.get(kind);
  }

  kinds(): readonly string[] {
    return [...this.#adapters.keys()].sort();
  }
}

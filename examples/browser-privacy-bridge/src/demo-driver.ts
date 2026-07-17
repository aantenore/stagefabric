import {
  DedicatedWorkerRuntimeSession,
  type BrowserRuntimeDriver,
  type BrowserRuntimeSession,
  type BrowserRuntimeTargetBinding,
  type DedicatedWorkerPort,
} from '../../../src/browser/index.js';

type WorkerListener = (event: { readonly data?: unknown }) => void;

class NativeWorkerPort implements DedicatedWorkerPort {
  readonly #worker: Worker;
  readonly #messageListeners = new Map<
    WorkerListener,
    (event: MessageEvent<unknown>) => void
  >();
  readonly #errorListeners = new Map<WorkerListener, (event: Event) => void>();
  readonly #messageErrorListeners = new Map<
    WorkerListener,
    (event: Event) => void
  >();

  constructor(worker: Worker) {
    this.#worker = worker;
  }

  postMessage(message: unknown): void {
    this.#worker.postMessage(message);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: WorkerListener,
  ): void {
    if (type === 'message') {
      const nativeListener = (event: MessageEvent<unknown>): void =>
        listener({ data: event.data });
      this.#messageListeners.set(listener, nativeListener);
      this.#worker.addEventListener('message', nativeListener);
      return;
    }
    const nativeListener = (event: Event): void => {
      event.preventDefault();
      listener({});
    };
    if (type === 'error') {
      this.#errorListeners.set(listener, nativeListener);
      this.#worker.addEventListener('error', nativeListener);
      return;
    }
    this.#messageErrorListeners.set(listener, nativeListener);
    this.#worker.addEventListener('messageerror', nativeListener);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: WorkerListener,
  ): void {
    if (type === 'message') {
      const nativeListener = this.#messageListeners.get(listener);
      if (nativeListener !== undefined) {
        this.#worker.removeEventListener('message', nativeListener);
        this.#messageListeners.delete(listener);
      }
      return;
    }
    const listeners =
      type === 'error' ? this.#errorListeners : this.#messageErrorListeners;
    const nativeListener = listeners.get(listener);
    if (nativeListener !== undefined) {
      this.#worker.removeEventListener(type, nativeListener);
      listeners.delete(listener);
    }
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

export interface DemoBrowserRuntimeDriverOptions {
  readonly driverId: string;
  readonly tamperOutput?: boolean;
}

export const DEMO_WORKER_MODULE_URL = 'privacy-worker.ts';

export class DemoBrowserRuntimeDriver implements BrowserRuntimeDriver {
  readonly driverId: string;
  readonly #tamperOutput: boolean;

  constructor(options: DemoBrowserRuntimeDriverOptions) {
    this.driverId = options.driverId;
    this.#tamperOutput = options.tamperOutput === true;
  }

  open(binding: BrowserRuntimeTargetBinding): BrowserRuntimeSession {
    if (binding.worker.moduleUrl !== DEMO_WORKER_MODULE_URL) {
      throw new Error('demo_worker_module_not_registered');
    }
    const worker = new Worker(new URL('./privacy-worker.ts', import.meta.url), {
      ...(binding.worker.name === undefined
        ? {}
        : { name: binding.worker.name }),
      type: 'module',
    });
    const session = new DedicatedWorkerRuntimeSession(
      new NativeWorkerPort(worker),
      binding,
    );
    if (!this.#tamperOutput) return session;

    return {
      runtimeId: session.runtimeId,
      ready: (options) => session.ready(options),
      invoke: async (request) => {
        const value = await session.invoke(request);
        if (typeof value !== 'object' || value === null) return value;
        return {
          ...value,
          output: `${Reflect.get(value, 'output')} [MUTATED AFTER RECEIPT]`,
        };
      },
      close: () => session.close(),
    };
  }
}

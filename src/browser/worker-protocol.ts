import type { BrowserRuntimeTargetBinding } from './bindings.js';
import { compareBrowserStrings } from './crypto.js';
import type {
  BrowserRuntimeInvocation,
  BrowserRuntimeReadiness,
  BrowserRuntimeSession,
} from './runtime-driver.js';

export const BROWSER_WORKER_PROTOCOL =
  'stagefabric.dev/browser-worker/v1' as const;

export type BrowserWorkerFailureCode =
  | 'aborted'
  | 'disposed'
  | 'invalid_message'
  | 'post_message_failed'
  | 'runtime_binding_mismatch'
  | 'timeout'
  | 'worker_failed'
  | 'worker_not_ready'
  | 'worker_rejected';

export class BrowserWorkerProtocolError extends Error {
  readonly code: BrowserWorkerFailureCode;

  constructor(code: BrowserWorkerFailureCode) {
    super(code);
    this.name = 'BrowserWorkerProtocolError';
    this.code = code;
  }
}

export interface DedicatedWorkerPort {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
  terminate(): void;
}

interface PendingExchange {
  readonly kind: 'ready' | 'result';
  readonly expectedRuntimeId: string | undefined;
  readonly expectedOperation: string | undefined;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: BrowserWorkerProtocolError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
  );
}

function defaultRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (randomUuid === undefined) {
    throw new BrowserWorkerProtocolError('worker_failed');
  }
  return randomUuid.call(globalThis.crypto);
}

function cleanCapabilities(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const capabilities = value.filter(isSafeIdentifier);
  if (capabilities.length !== value.length) return undefined;
  const unique = [...new Set(capabilities)].sort(compareBrowserStrings);
  if (unique.length !== capabilities.length) return undefined;
  return Object.freeze(unique);
}

export interface DedicatedWorkerRuntimeSessionOptions {
  readonly requestId?: () => string;
}

/**
 * A strict host-side Dedicated Worker protocol. It never infers SDK, model, or
 * endpoint details; all initialization data comes from the sealed binding.
 */
export class DedicatedWorkerRuntimeSession implements BrowserRuntimeSession {
  readonly runtimeId: string;
  readonly #binding: BrowserRuntimeTargetBinding;
  readonly #worker: DedicatedWorkerPort;
  readonly #requestId: () => string;
  readonly #pending = new Map<string, PendingExchange>();
  readonly #usedRequestIds = new Set<string>();
  readonly #onMessageBound: (event: { readonly data?: unknown }) => void;
  readonly #onErrorBound: () => void;
  #readiness: BrowserRuntimeReadiness | undefined;
  #readyPromise: Promise<BrowserRuntimeReadiness> | undefined;
  #disposed = false;

  constructor(
    worker: DedicatedWorkerPort,
    binding: BrowserRuntimeTargetBinding,
    options: DedicatedWorkerRuntimeSessionOptions = {},
  ) {
    this.#worker = worker;
    this.#binding = structuredClone(binding);
    this.runtimeId = this.#binding.runtimeId;
    this.#requestId = options.requestId ?? defaultRequestId;
    this.#onMessageBound = (event) => this.#onMessage(event.data);
    this.#onErrorBound = () => this.#terminateFailedWorker();
    worker.addEventListener('message', this.#onMessageBound);
    worker.addEventListener('error', this.#onErrorBound);
    worker.addEventListener('messageerror', this.#onErrorBound);
  }

  async ready(options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<BrowserRuntimeReadiness> {
    if (this.#disposed) throw new BrowserWorkerProtocolError('disposed');
    if (this.#readiness !== undefined) return this.#readiness;
    if (this.#readyPromise !== undefined) return this.#readyPromise;

    const requestId = this.#nextRequestId();
    this.#readyPromise = this.#exchange(
      {
        protocol: BROWSER_WORKER_PROTOCOL,
        kind: 'initialize',
        requestId,
        runtimeId: this.#binding.runtimeId,
        driverId: this.#binding.driverId,
        configuration: structuredClone(this.#binding.configuration),
      },
      'ready',
      options.timeoutMs,
      options.signal,
    )
      .then((message) => {
        const capabilities = cleanCapabilities(message['capabilities']);
        if (
          message['runtimeId'] !== this.#binding.runtimeId ||
          message['driverId'] !== this.#binding.driverId ||
          capabilities === undefined
        ) {
          throw new BrowserWorkerProtocolError('runtime_binding_mismatch');
        }
        const readiness = Object.freeze({
          runtimeId: this.#binding.runtimeId,
          driverId: this.#binding.driverId,
          capabilities,
        });
        this.#readiness = readiness;
        return readiness;
      })
      .catch((error: unknown) => {
        this.#readyPromise = undefined;
        if (error instanceof BrowserWorkerProtocolError) throw error;
        throw new BrowserWorkerProtocolError('worker_failed');
      });

    return this.#readyPromise;
  }

  async invoke(request: BrowserRuntimeInvocation): Promise<unknown> {
    if (this.#disposed) throw new BrowserWorkerProtocolError('disposed');
    if (this.#readiness === undefined) {
      throw new BrowserWorkerProtocolError('worker_not_ready');
    }
    if (!isSafeIdentifier(request.operation)) {
      throw new BrowserWorkerProtocolError('invalid_message');
    }

    const requestId = this.#nextRequestId();
    const response = await this.#exchange(
      {
        protocol: BROWSER_WORKER_PROTOCOL,
        kind: 'invoke',
        requestId,
        runtimeId: this.#binding.runtimeId,
        operation: request.operation,
        input: request.input,
      },
      'result',
      request.timeoutMs,
      request.signal,
    );
    if (!Object.hasOwn(response, 'output')) {
      throw new BrowserWorkerProtocolError('invalid_message');
    }
    return response['output'];
  }

  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectAll('disposed');
    this.#worker.removeEventListener('message', this.#onMessageBound);
    this.#worker.removeEventListener('error', this.#onErrorBound);
    this.#worker.removeEventListener('messageerror', this.#onErrorBound);
    try {
      this.#worker.terminate();
    } catch {
      throw new BrowserWorkerProtocolError('worker_failed');
    }
  }

  #nextRequestId(): string {
    let requestId: string;
    try {
      requestId = this.#requestId();
    } catch (error) {
      if (error instanceof BrowserWorkerProtocolError) throw error;
      throw new BrowserWorkerProtocolError('worker_failed');
    }
    if (!isSafeIdentifier(requestId) || this.#usedRequestIds.has(requestId)) {
      throw new BrowserWorkerProtocolError('invalid_message');
    }
    this.#usedRequestIds.add(requestId);
    return requestId;
  }

  #exchange(
    message: Readonly<Record<string, unknown>>,
    responseKind: PendingExchange['kind'],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new BrowserWorkerProtocolError('invalid_message'));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new BrowserWorkerProtocolError('aborted'));
    }

    const requestId = message['requestId'];
    if (!isSafeIdentifier(requestId)) {
      return Promise.reject(new BrowserWorkerProtocolError('invalid_message'));
    }
    let expectedRuntimeId: string | undefined;
    let expectedOperation: string | undefined;
    if (responseKind === 'result') {
      const runtimeId = message['runtimeId'];
      const operation = message['operation'];
      if (!isSafeIdentifier(runtimeId) || !isSafeIdentifier(operation)) {
        return Promise.reject(
          new BrowserWorkerProtocolError('invalid_message'),
        );
      }
      expectedRuntimeId = runtimeId;
      expectedOperation = operation;
    }

    return new Promise((resolve, reject) => {
      const fail = (code: BrowserWorkerFailureCode): void => {
        this.#sendAbort(requestId);
        this.#settle(requestId, () =>
          reject(new BrowserWorkerProtocolError(code)),
        );
        if (code === 'timeout') this.#terminateFailedWorker();
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      const abortListener =
        signal === undefined ? undefined : () => fail('aborted');
      if (abortListener !== undefined) {
        signal!.addEventListener('abort', abortListener, { once: true });
      }
      this.#pending.set(requestId, {
        kind: responseKind,
        expectedRuntimeId,
        expectedOperation,
        resolve,
        reject,
        timer,
        signal,
        abortListener,
      });

      try {
        this.#worker.postMessage(message);
      } catch {
        this.#settle(requestId, () =>
          reject(new BrowserWorkerProtocolError('post_message_failed')),
        );
      }
    });
  }

  #onMessage(value: unknown): void {
    if (!isPlainRecord(value)) return;
    const requestId = value['requestId'];
    if (!isSafeIdentifier(requestId)) return;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;

    if (
      value['protocol'] !== BROWSER_WORKER_PROTOCOL ||
      typeof value['kind'] !== 'string'
    ) {
      this.#settle(requestId, () =>
        pending.reject(new BrowserWorkerProtocolError('invalid_message')),
      );
      return;
    }

    if (value['kind'] === 'error') {
      if (!isSafeIdentifier(value['errorCode'])) {
        this.#settle(requestId, () =>
          pending.reject(new BrowserWorkerProtocolError('invalid_message')),
        );
        return;
      }
      this.#settle(requestId, () =>
        pending.reject(new BrowserWorkerProtocolError('worker_rejected')),
      );
      return;
    }

    if (value['kind'] !== pending.kind) {
      this.#settle(requestId, () =>
        pending.reject(new BrowserWorkerProtocolError('invalid_message')),
      );
      return;
    }
    if (
      pending.kind === 'result' &&
      (value['runtimeId'] !== pending.expectedRuntimeId ||
        value['operation'] !== pending.expectedOperation)
    ) {
      this.#settle(requestId, () =>
        pending.reject(
          new BrowserWorkerProtocolError('runtime_binding_mismatch'),
        ),
      );
      return;
    }
    this.#settle(requestId, () => pending.resolve(value));
  }

  #sendAbort(requestId: string): void {
    try {
      this.#worker.postMessage({
        protocol: BROWSER_WORKER_PROTOCOL,
        kind: 'abort',
        requestId,
        runtimeId: this.#binding.runtimeId,
      });
    } catch {
      // The local failure remains authoritative and is already fail-closed.
    }
  }

  #settle(requestId: string, settle: () => void): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.abortListener !== undefined) {
      pending.signal?.removeEventListener('abort', pending.abortListener);
    }
    settle();
  }

  #rejectAll(code: BrowserWorkerFailureCode): void {
    for (const [requestId, pending] of this.#pending) {
      this.#settle(requestId, () =>
        pending.reject(new BrowserWorkerProtocolError(code)),
      );
    }
  }

  #terminateFailedWorker(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectAll('worker_failed');
    this.#worker.removeEventListener('message', this.#onMessageBound);
    this.#worker.removeEventListener('error', this.#onErrorBound);
    this.#worker.removeEventListener('messageerror', this.#onErrorBound);
    try {
      this.#worker.terminate();
    } catch {
      // The correlated worker failure remains authoritative and fail-closed.
    }
  }
}

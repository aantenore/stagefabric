import { describe, expect, it, vi } from 'vitest';

import type { BrowserRuntimeTargetBinding } from '../../src/browser/bindings.js';
import {
  BROWSER_WORKER_PROTOCOL,
  BrowserWorkerProtocolError,
  DedicatedWorkerRuntimeSession,
  type DedicatedWorkerPort,
} from '../../src/browser/worker-protocol.js';

class FakeWorker implements DedicatedWorkerPort {
  readonly posted: unknown[] = [];
  readonly listeners = new Map<
    string,
    Set<(event: { data?: unknown }) => void>
  >();
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: { data?: unknown }) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: 'message' | 'error' | 'messageerror', data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

class ThrowingTerminateWorker extends FakeWorker {
  override terminate(): void {
    throw new Error('native-worker-detail-must-not-escape');
  }
}

function binding(): BrowserRuntimeTargetBinding {
  return {
    runtimeId: 'runtime-a',
    driverId: 'driver-a',
    worker: { moduleUrl: '/worker.js', type: 'module' },
    requirements: { secureContext: true, webGpu: false, wasm: true },
    configuration: { artifact: 'operator-artifact' },
  };
}

describe('DedicatedWorkerRuntimeSession', () => {
  it('uses one cloned runtime identifier throughout the session', () => {
    const worker = new FakeWorker();
    const mutable = binding() as BrowserRuntimeTargetBinding & {
      runtimeId: string;
    };
    let runtimeIdReads = 0;
    Object.defineProperty(mutable, 'runtimeId', {
      enumerable: true,
      get() {
        runtimeIdReads += 1;
        return runtimeIdReads === 1 ? 'runtime-a' : 'runtime-b';
      },
    });

    const session = new DedicatedWorkerRuntimeSession(worker, mutable, {
      requestId: () => 'init-1',
    });
    expect(session.runtimeId).toBe('runtime-a');
    expect(runtimeIdReads).toBe(1);
    session.close();
  });

  it('requires correlated readiness before invocation', async () => {
    const worker = new FakeWorker();
    const ids = ['init-1', 'invoke-1'];
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => ids.shift()!,
    });

    const readyPromise = session.ready({ timeoutMs: 1_000 });
    expect(worker.posted[0]).toMatchObject({
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'initialize',
      requestId: 'init-1',
      runtimeId: 'runtime-a',
      driverId: 'driver-a',
    });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'ready',
      requestId: 'init-1',
      runtimeId: 'runtime-a',
      driverId: 'driver-a',
      capabilities: ['wasm', 'local-inference'],
    });
    await expect(readyPromise).resolves.toEqual({
      runtimeId: 'runtime-a',
      driverId: 'driver-a',
      capabilities: ['local-inference', 'wasm'],
    });

    const invocation = session.invoke({
      operation: 'redact',
      input: 'private value',
      timeoutMs: 1_000,
    });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'result',
      requestId: 'invoke-1',
      runtimeId: 'runtime-a',
      operation: 'redact',
      output: { safe: true },
    });
    await expect(invocation).resolves.toEqual({ safe: true });
    session.close();
    expect(worker.terminated).toBe(true);
  });

  it('rejects mismatched or malformed correlated messages', async () => {
    const worker = new FakeWorker();
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => 'init-1',
    });
    const ready = session.ready({ timeoutMs: 1_000 });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'ready',
      requestId: 'init-1',
      runtimeId: 'other-runtime',
      driverId: 'driver-a',
      capabilities: [],
    });
    await expect(ready).rejects.toMatchObject({
      code: 'runtime_binding_mismatch',
    });

    const secondWorker = new FakeWorker();
    const second = new DedicatedWorkerRuntimeSession(secondWorker, binding(), {
      requestId: () => 'init-2',
    });
    const malformed = second.ready({ timeoutMs: 1_000 });
    secondWorker.emit('message', {
      protocol: 'unexpected',
      kind: 'ready',
      requestId: 'init-2',
    });
    await expect(malformed).rejects.toMatchObject({ code: 'invalid_message' });
    second.close();
  });

  it('propagates abort and terminates a timed-out worker fail-closed', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
        requestId: () => 'init-timeout',
      });
      const ready = session.ready({ timeoutMs: 50 });
      const timedOut = expect(ready).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(51);
      await timedOut;
      expect(worker.posted).toContainEqual({
        protocol: BROWSER_WORKER_PROTOCOL,
        kind: 'abort',
        requestId: 'init-timeout',
        runtimeId: 'runtime-a',
      });
      expect(worker.terminated).toBe(true);
      await expect(session.ready({ timeoutMs: 50 })).rejects.toBeInstanceOf(
        BrowserWorkerProtocolError,
      );
    } finally {
      vi.useRealTimers();
    }

    const worker = new FakeWorker();
    const controller = new AbortController();
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => 'init-abort',
    });
    const ready = session.ready({
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(ready).rejects.toMatchObject({ code: 'aborted' });
    expect(worker.terminated).toBe(false);
    session.close();
  });

  it('never reuses a completed request identifier in the same session', async () => {
    const worker = new FakeWorker();
    const ids = ['init-1', 'invoke-1', 'invoke-1'];
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => ids.shift()!,
    });

    const ready = session.ready({ timeoutMs: 1_000 });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'ready',
      requestId: 'init-1',
      runtimeId: 'runtime-a',
      driverId: 'driver-a',
      capabilities: ['redact'],
    });
    await ready;

    const first = session.invoke({
      operation: 'redact',
      input: 'private value',
      timeoutMs: 1_000,
    });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'result',
      requestId: 'invoke-1',
      runtimeId: 'runtime-a',
      operation: 'redact',
      output: { safe: true },
    });
    await expect(first).resolves.toEqual({ safe: true });

    await expect(
      session.invoke({
        operation: 'redact',
        input: 'another private value',
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'invalid_message' });
    expect(
      worker.posted.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          Reflect.get(message, 'kind') === 'invoke',
      ),
    ).toHaveLength(1);
    session.close();
  });

  it('rejects reuse after abort and ignores the delayed old result', async () => {
    const worker = new FakeWorker();
    const ids = ['init-1', 'invoke-delayed', 'invoke-delayed'];
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => ids.shift()!,
    });

    const ready = session.ready({ timeoutMs: 1_000 });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'ready',
      requestId: 'init-1',
      runtimeId: 'runtime-a',
      driverId: 'driver-a',
      capabilities: ['redact'],
    });
    await ready;

    const controller = new AbortController();
    const first = session.invoke({
      operation: 'redact',
      input: 'private value',
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'aborted' });

    await expect(
      session.invoke({
        operation: 'redact',
        input: 'new private value',
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'invalid_message' });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'result',
      requestId: 'invoke-delayed',
      runtimeId: 'runtime-a',
      operation: 'redact',
      output: { stale: true },
    });
    expect(
      worker.posted.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          Reflect.get(message, 'kind') === 'invoke',
      ),
    ).toHaveLength(1);
    session.close();
  });

  it('requires result responses to echo the exact runtime and operation', async () => {
    const worker = new FakeWorker();
    const ids = ['init-1', 'invoke-runtime', 'invoke-operation'];
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => ids.shift()!,
    });

    const ready = session.ready({ timeoutMs: 1_000 });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'ready',
      requestId: 'init-1',
      runtimeId: 'runtime-a',
      driverId: 'driver-a',
      capabilities: ['redact'],
    });
    await ready;

    const runtimeMismatch = session.invoke({
      operation: 'redact',
      input: 'private value',
      timeoutMs: 1_000,
    });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'result',
      requestId: 'invoke-runtime',
      runtimeId: 'runtime-b',
      operation: 'redact',
      output: { safe: true },
    });
    await expect(runtimeMismatch).rejects.toMatchObject({
      code: 'runtime_binding_mismatch',
    });

    const operationMismatch = session.invoke({
      operation: 'redact',
      input: 'private value',
      timeoutMs: 1_000,
    });
    worker.emit('message', {
      protocol: BROWSER_WORKER_PROTOCOL,
      kind: 'result',
      requestId: 'invoke-operation',
      runtimeId: 'runtime-a',
      operation: 'summarize',
      output: { safe: true },
    });
    await expect(operationMismatch).rejects.toMatchObject({
      code: 'runtime_binding_mismatch',
    });
    session.close();
  });

  it('requires termination and normalizes native termination failures', async () => {
    const worker = new ThrowingTerminateWorker();
    const session = new DedicatedWorkerRuntimeSession(worker, binding(), {
      requestId: () => 'init-close',
    });
    expect(() => session.close()).toThrowError(
      expect.objectContaining({ code: 'worker_failed' }),
    );

    vi.useFakeTimers();
    try {
      const timedWorker = new ThrowingTerminateWorker();
      const timedSession = new DedicatedWorkerRuntimeSession(
        timedWorker,
        binding(),
        { requestId: () => 'init-timeout-terminate' },
      );
      const readiness = timedSession.ready({ timeoutMs: 10 });
      const rejection = expect(readiness).rejects.toMatchObject({
        code: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

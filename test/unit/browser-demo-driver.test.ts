import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEMO_WORKER_MODULE_URL,
  DemoBrowserRuntimeDriver,
} from '../../examples/browser-privacy-bridge/src/demo-driver.js';
import type { BrowserRuntimeTargetBinding } from '../../src/browser/bindings.js';

function binding(
  moduleUrl = DEMO_WORKER_MODULE_URL,
): BrowserRuntimeTargetBinding {
  return {
    runtimeId: 'runtime-a',
    driverId: 'driver-a',
    worker: { moduleUrl, type: 'module' },
    requirements: { secureContext: true, webGpu: false, wasm: true },
    configuration: {},
  };
}

class BrowserWorkerDouble {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  terminated = false;

  postMessage(): void {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('DemoBrowserRuntimeDriver', () => {
  it('rejects a binding whose Worker module is not the registered factory', () => {
    const driver = new DemoBrowserRuntimeDriver({ driverId: 'driver-a' });
    expect(() => driver.open(binding('./other-worker.ts'))).toThrow(
      'demo_worker_module_not_registered',
    );
  });

  it('suppresses raw Worker error events before failing the session closed', () => {
    let worker: BrowserWorkerDouble | undefined;
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          worker = new BrowserWorkerDouble();
          return worker;
        }
      },
    );
    const driver = new DemoBrowserRuntimeDriver({ driverId: 'driver-a' });
    driver.open(binding());
    const event = new Event('error', { cancelable: true });

    worker!.emit('error', event);

    expect(event.defaultPrevented).toBe(true);
    expect(worker!.terminated).toBe(true);
  });
});

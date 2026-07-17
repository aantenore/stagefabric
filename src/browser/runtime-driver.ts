import type { BrowserRuntimeTargetBinding } from './bindings.js';
import { compareBrowserStrings } from './crypto.js';

export interface BrowserRuntimeInvocation {
  readonly operation: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface BrowserRuntimeSession {
  readonly runtimeId: string;
  ready(options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<BrowserRuntimeReadiness>;
  invoke(request: BrowserRuntimeInvocation): Promise<unknown>;
  close(): void | Promise<void>;
}

export interface BrowserRuntimeReadiness {
  readonly runtimeId: string;
  readonly driverId: string;
  readonly capabilities: readonly string[];
}

/**
 * Provider-neutral browser runtime port. Drivers own SDK/model specifics and
 * receive only operator-supplied bindings.
 */
export interface BrowserRuntimeDriver {
  readonly driverId: string;
  open(binding: BrowserRuntimeTargetBinding): BrowserRuntimeSession;
}

export interface BrowserRuntimeDriverResolver {
  get(driverId: string): BrowserRuntimeDriver | undefined;
}

const SAFE_DRIVER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class BrowserRuntimeDriverRegistry implements BrowserRuntimeDriverResolver {
  readonly #drivers = new Map<string, BrowserRuntimeDriver>();

  constructor(drivers: readonly BrowserRuntimeDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: BrowserRuntimeDriver): this {
    if (!SAFE_DRIVER_ID.test(driver.driverId)) {
      throw new Error('invalid_browser_runtime_driver_id');
    }
    if (this.#drivers.has(driver.driverId)) {
      throw new Error('browser_runtime_driver_already_registered');
    }
    this.#drivers.set(driver.driverId, driver);
    return this;
  }

  get(driverId: string): BrowserRuntimeDriver | undefined {
    return this.#drivers.get(driverId);
  }

  require(driverId: string): BrowserRuntimeDriver {
    const driver = this.get(driverId);
    if (driver === undefined) {
      throw new Error('browser_runtime_driver_not_registered');
    }
    return driver;
  }

  ids(): readonly string[] {
    return [...this.#drivers.keys()].sort(compareBrowserStrings);
  }
}

import type { BrowserCapabilityRequirements } from './bindings.js';

export type BrowserCapabilityName = 'secure-context' | 'webgpu' | 'wasm';

export type BrowserCapabilityReasonCode =
  | 'available'
  | 'secure_context_unavailable'
  | 'webgpu_api_unavailable'
  | 'webgpu_adapter_unavailable'
  | 'webgpu_probe_failed'
  | 'wasm_api_unavailable'
  | 'wasm_validation_failed';

export interface BrowserCapabilityResult {
  readonly capability: BrowserCapabilityName;
  readonly required: boolean;
  readonly available: boolean;
  readonly reasonCode: BrowserCapabilityReasonCode;
}

export interface BrowserCapabilitySnapshot {
  readonly kind: 'BrowserCapabilitySnapshot';
  readonly eligible: boolean;
  readonly capabilities: readonly BrowserCapabilityResult[];
}

interface GpuProbePort {
  requestAdapter(): Promise<object | null>;
}

interface WasmProbePort {
  validate(bytes: BufferSource): boolean;
}

export interface BrowserCapabilityProbeEnvironment {
  readonly isSecureContext: boolean;
  readonly gpu: GpuProbePort | undefined;
  readonly wasm: WasmProbePort | undefined;
}

export interface BrowserCapabilityProbeOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 1_000;

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('browser_capability_probe_timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function defaultEnvironment(): BrowserCapabilityProbeEnvironment {
  const globals = globalThis as typeof globalThis & {
    readonly isSecureContext?: boolean;
    readonly navigator?: { readonly gpu?: GpuProbePort };
    readonly WebAssembly?: WasmProbePort;
  };
  return {
    isSecureContext: globals.isSecureContext === true,
    gpu: globals.navigator?.gpu,
    wasm: globals.WebAssembly,
  };
}

function result(
  capability: BrowserCapabilityName,
  required: boolean,
  available: boolean,
  reasonCode: BrowserCapabilityReasonCode,
): BrowserCapabilityResult {
  return Object.freeze({ capability, required, available, reasonCode });
}

/**
 * Probes only coarse availability. It deliberately never reads adapter
 * vendor, architecture, limits, features, timing, user-agent, or device data.
 */
export async function probeBrowserCapabilities(
  requirements: BrowserCapabilityRequirements,
  environment: BrowserCapabilityProbeEnvironment = defaultEnvironment(),
  options: BrowserCapabilityProbeOptions = {},
): Promise<BrowserCapabilitySnapshot> {
  let requirementsSnapshot: BrowserCapabilityRequirements;
  try {
    requirementsSnapshot = Object.freeze({
      secureContext: requirements.secureContext,
      webGpu: requirements.webGpu,
      wasm: requirements.wasm,
    });
  } catch {
    throw new TypeError('invalid_browser_capability_requirements');
  }
  if (
    typeof requirementsSnapshot.secureContext !== 'boolean' ||
    typeof requirementsSnapshot.webGpu !== 'boolean' ||
    typeof requirementsSnapshot.wasm !== 'boolean'
  ) {
    throw new TypeError('invalid_browser_capability_requirements');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('invalid_browser_capability_probe_timeout');
  }

  let isSecureContext = false;
  let gpuPort: GpuProbePort | undefined;
  let requestAdapter: GpuProbePort['requestAdapter'] | undefined;
  let gpuProbeAccessFailed = false;
  let wasmPort: WasmProbePort | undefined;
  let validateWasm: WasmProbePort['validate'] | undefined;
  let wasmProbeAccessFailed = false;
  try {
    isSecureContext = environment.isSecureContext === true;
  } catch {
    isSecureContext = false;
  }
  try {
    gpuPort = environment.gpu;
    requestAdapter = gpuPort?.requestAdapter;
  } catch {
    gpuProbeAccessFailed = true;
  }
  try {
    wasmPort = environment.wasm;
    validateWasm = wasmPort?.validate;
  } catch {
    wasmProbeAccessFailed = true;
  }
  const secureContext = result(
    'secure-context',
    requirementsSnapshot.secureContext,
    isSecureContext,
    isSecureContext ? 'available' : 'secure_context_unavailable',
  );

  let webGpu: BrowserCapabilityResult;
  if (gpuProbeAccessFailed) {
    webGpu = result(
      'webgpu',
      requirementsSnapshot.webGpu,
      false,
      'webgpu_probe_failed',
    );
  } else if (gpuPort === undefined || typeof requestAdapter !== 'function') {
    webGpu = result(
      'webgpu',
      requirementsSnapshot.webGpu,
      false,
      'webgpu_api_unavailable',
    );
  } else {
    try {
      const adapter = await withTimeout(
        Promise.resolve().then(() =>
          Reflect.apply(requestAdapter, gpuPort, []),
        ),
        timeoutMs,
      );
      const available = typeof adapter === 'object' && adapter !== null;
      webGpu = result(
        'webgpu',
        requirementsSnapshot.webGpu,
        available,
        available ? 'available' : 'webgpu_adapter_unavailable',
      );
    } catch {
      webGpu = result(
        'webgpu',
        requirementsSnapshot.webGpu,
        false,
        'webgpu_probe_failed',
      );
    }
  }

  let wasm: BrowserCapabilityResult;
  if (wasmProbeAccessFailed) {
    wasm = result(
      'wasm',
      requirementsSnapshot.wasm,
      false,
      'wasm_validation_failed',
    );
  } else if (wasmPort === undefined || typeof validateWasm !== 'function') {
    wasm = result(
      'wasm',
      requirementsSnapshot.wasm,
      false,
      'wasm_api_unavailable',
    );
  } else {
    let available = false;
    try {
      // A fixed empty module proves support without revealing device details.
      available =
        Reflect.apply(validateWasm, wasmPort, [
          new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        ]) === true;
    } catch {
      available = false;
    }
    wasm = result(
      'wasm',
      requirementsSnapshot.wasm,
      available,
      available ? 'available' : 'wasm_validation_failed',
    );
  }

  const capabilities = Object.freeze([secureContext, webGpu, wasm]);
  return Object.freeze({
    kind: 'BrowserCapabilitySnapshot' as const,
    eligible: capabilities.every(
      (capability) => !capability.required || capability.available,
    ),
    capabilities,
  });
}

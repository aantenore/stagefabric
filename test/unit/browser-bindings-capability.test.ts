import { describe, expect, it } from 'vitest';

import {
  BROWSER_RUNTIME_API_VERSION,
  BROWSER_RUNTIME_CONFIGURATION_LIMITS,
  browserRuntimeBindingsContentSchema,
  sealBrowserRuntimeBindings,
  verifyBrowserRuntimeBindings,
  type BrowserRuntimeBindingsContent,
} from '../../src/browser/bindings.js';
import { probeBrowserCapabilities } from '../../src/browser/capability-probe.js';
import {
  BrowserRuntimeDriverRegistry,
  type BrowserRuntimeDriver,
} from '../../src/browser/runtime-driver.js';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function content(): BrowserRuntimeBindingsContent {
  return {
    apiVersion: BROWSER_RUNTIME_API_VERSION,
    kind: 'BrowserRuntimeBindings',
    operatorId: 'operator-a',
    policy: {
      policyId: 'browser-private-v1',
      redactionPolicyId: 'redaction-v1',
      redactionPolicyDigest: digest('a'),
      redactionRuleIds: ['email-rule'],
      redactionClassifierIds: [],
      egressPolicyId: 'egress-v1',
      egressPolicyDigest: digest('b'),
      capabilityProbeTimeoutMs: 500,
      workerReadyTimeoutMs: 1_000,
      invocationTimeoutMs: 5_000,
      cleanupTimeoutMs: 500,
      maxInputBytes: 64_000,
      maxOutputBytes: 64_000,
    },
    runtimes: [
      {
        runtimeId: 'private-browser',
        driverId: 'operator-driver',
        worker: { moduleUrl: '/workers/private-runtime.js', type: 'module' },
        requirements: { secureContext: true, webGpu: true, wasm: true },
        configuration: { artifact: { source: '/models/operator-selected' } },
      },
    ],
  };
}

describe('browser runtime bindings', () => {
  it('seals strict operator-owned configuration with Web Crypto', async () => {
    const sealed = await sealBrowserRuntimeBindings(content());
    expect(await verifyBrowserRuntimeBindings(sealed)).toBe(true);

    const tampered = structuredClone(sealed);
    tampered.policy.egressPolicyId = 'other-egress';
    expect(await verifyBrowserRuntimeBindings(tampered)).toBe(false);
  });

  it('rejects unknown fields, duplicate runtimes, unsafe URLs and reserved keys', () => {
    const extra = { ...content(), endpoint: 'https://unexpected.invalid' };
    expect(browserRuntimeBindingsContentSchema.safeParse(extra).success).toBe(
      false,
    );

    const duplicate = content();
    duplicate.runtimes.push(structuredClone(duplicate.runtimes[0]!));
    expect(
      browserRuntimeBindingsContentSchema.safeParse(duplicate).success,
    ).toBe(false);

    const unsafe = content();
    unsafe.runtimes[0]!.worker.moduleUrl = 'javascript:alert(1)';
    expect(browserRuntimeBindingsContentSchema.safeParse(unsafe).success).toBe(
      false,
    );

    const empty = content();
    empty.runtimes[0]!.worker.moduleUrl = '   ';
    expect(browserRuntimeBindingsContentSchema.safeParse(empty).success).toBe(
      false,
    );

    const reserved = content() as unknown as {
      runtimes: { configuration: Record<string, unknown> }[];
    };
    reserved.runtimes[0]!.configuration = JSON.parse(
      '{"nested":{"constructor":"value"}}',
    ) as Record<string, unknown>;
    expect(
      browserRuntimeBindingsContentSchema.safeParse(reserved).success,
    ).toBe(false);

    const duplicateSources = content();
    duplicateSources.policy.redactionRuleIds = ['email-rule', 'email-rule'];
    expect(
      browserRuntimeBindingsContentSchema.safeParse(duplicateSources).success,
    ).toBe(false);

    const ambiguousSources = content();
    ambiguousSources.policy.redactionClassifierIds = ['email-rule'];
    expect(
      browserRuntimeBindingsContentSchema.safeParse(ambiguousSources).success,
    ).toBe(false);
  });

  it('snapshots configuration without invoking getters', () => {
    const candidate = content() as unknown as {
      runtimes: { configuration: Record<string, unknown> }[];
    };
    let getterCalls = 0;
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-be-read';
      },
    });
    candidate.runtimes[0]!.configuration = { nested };

    expect(
      browserRuntimeBindingsContentSchema.safeParse(candidate).success,
    ).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('rejects cycles and excessive depth without overflowing the stack', () => {
    const cyclic = content() as unknown as {
      runtimes: { configuration: Record<string, unknown> }[];
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclic.runtimes[0]!.configuration = cycle;
    expect(() =>
      browserRuntimeBindingsContentSchema.safeParse(cyclic),
    ).not.toThrow();
    expect(browserRuntimeBindingsContentSchema.safeParse(cyclic).success).toBe(
      false,
    );

    const deeplyNested = content() as unknown as {
      runtimes: { configuration: Record<string, unknown> }[];
    };
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (
      let depth = 0;
      depth < BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxDepth + 10_000;
      depth += 1
    ) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    deeplyNested.runtimes[0]!.configuration = root;
    expect(() =>
      browserRuntimeBindingsContentSchema.safeParse(deeplyNested),
    ).not.toThrow();
    expect(
      browserRuntimeBindingsContentSchema.safeParse(deeplyNested).success,
    ).toBe(false);
  });

  it('fails closed when the total configuration node budget is exceeded', () => {
    const candidate = content() as unknown as {
      runtimes: { configuration: Record<string, unknown> }[];
    };
    const valuesPerArray = BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxArrayLength;
    const arrays = Math.ceil(
      BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxNodes / valuesPerArray,
    );
    candidate.runtimes[0]!.configuration = Object.fromEntries(
      Array.from({ length: arrays }, (_, index) => [
        `batch-${index}`,
        Array.from({ length: valuesPerArray }, () => null),
      ]),
    );

    expect(() =>
      browserRuntimeBindingsContentSchema.safeParse(candidate),
    ).not.toThrow();
    expect(
      browserRuntimeBindingsContentSchema.safeParse(candidate).success,
    ).toBe(false);
  });

  it('fails closed when the cumulative configuration string budget is exceeded', () => {
    const candidate = content() as unknown as {
      runtimes: { configuration: Record<string, unknown> }[];
    };
    const perString = BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxStringCodeUnits;
    const stringCount =
      Math.floor(
        BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxTotalStringCodeUnits /
          perString,
      ) + 1;
    candidate.runtimes[0]!.configuration = Object.fromEntries(
      Array.from({ length: stringCount }, (_, index) => [
        `value-${index}`,
        'x'.repeat(perString),
      ]),
    );

    expect(
      browserRuntimeBindingsContentSchema.safeParse(candidate).success,
    ).toBe(false);
  });
});

describe('privacy-preserving capability probe', () => {
  it('reports only coarse capability outcomes and never inspects adapter data', async () => {
    const adapter = {};
    Object.defineProperty(adapter, 'vendor', {
      get() {
        throw new Error('fingerprinting attempted');
      },
    });
    Object.defineProperty(adapter, 'limits', {
      get() {
        throw new Error('fingerprinting attempted');
      },
    });
    const snapshot = await probeBrowserCapabilities(
      { secureContext: true, webGpu: true, wasm: true },
      {
        isSecureContext: true,
        gpu: { requestAdapter: async () => adapter },
        wasm: { validate: () => true },
      },
    );

    expect(snapshot.eligible).toBe(true);
    expect(snapshot.capabilities).toEqual([
      {
        capability: 'secure-context',
        required: true,
        available: true,
        reasonCode: 'available',
      },
      {
        capability: 'webgpu',
        required: true,
        available: true,
        reasonCode: 'available',
      },
      {
        capability: 'wasm',
        required: true,
        available: true,
        reasonCode: 'available',
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/vendor|architecture|limits/i);
  });

  it('uses stable reason codes and blocks only unavailable required capabilities', async () => {
    const required = await probeBrowserCapabilities(
      { secureContext: true, webGpu: true, wasm: false },
      { isSecureContext: false, gpu: undefined, wasm: undefined },
    );
    expect(required.eligible).toBe(false);
    expect(required.capabilities.map((item) => item.reasonCode)).toEqual([
      'secure_context_unavailable',
      'webgpu_api_unavailable',
      'wasm_api_unavailable',
    ]);

    const optional = await probeBrowserCapabilities(
      { secureContext: false, webGpu: false, wasm: false },
      { isSecureContext: false, gpu: undefined, wasm: undefined },
    );
    expect(optional.eligible).toBe(true);
  });

  it('fails closed for malformed capability port return values', async () => {
    const malformed = await probeBrowserCapabilities(
      { secureContext: true, webGpu: true, wasm: true },
      {
        isSecureContext: 'yes',
        gpu: { requestAdapter: async () => false },
        wasm: { validate: () => 'yes' },
      } as never,
    );

    expect(malformed.eligible).toBe(false);
    expect(malformed.capabilities.map(({ available }) => available)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('bounds a non-settling WebGPU adapter probe', async () => {
    const snapshot = await probeBrowserCapabilities(
      { secureContext: true, webGpu: true, wasm: false },
      {
        isSecureContext: true,
        gpu: { requestAdapter: () => new Promise(() => undefined) },
        wasm: undefined,
      },
      { timeoutMs: 5 },
    );

    expect(snapshot.eligible).toBe(false);
    expect(snapshot.capabilities[1]).toMatchObject({
      available: false,
      reasonCode: 'webgpu_probe_failed',
    });
  });

  it('reads only declared fields and normalizes relevant getter failures', async () => {
    let unrelatedGetterCalls = 0;
    const requirements = {
      secureContext: true,
      webGpu: true,
      wasm: false,
    } as Record<string, unknown>;
    Object.defineProperty(requirements, 'vendor', {
      enumerable: true,
      get() {
        unrelatedGetterCalls += 1;
        throw new Error('must-not-be-read');
      },
    });
    const gpu = {} as Record<string, unknown>;
    Object.defineProperty(gpu, 'requestAdapter', {
      enumerable: true,
      get() {
        throw new Error('probe-detail-must-not-escape');
      },
    });
    const environment = {
      isSecureContext: true,
      gpu,
      wasm: undefined,
    } as Record<string, unknown>;
    Object.defineProperty(environment, 'vendor', {
      enumerable: true,
      get() {
        unrelatedGetterCalls += 1;
        throw new Error('must-not-be-read');
      },
    });

    await expect(
      probeBrowserCapabilities(requirements as never, environment as never),
    ).resolves.toMatchObject({
      eligible: false,
      capabilities: [
        { capability: 'secure-context', available: true },
        {
          capability: 'webgpu',
          available: false,
          reasonCode: 'webgpu_probe_failed',
        },
        { capability: 'wasm', available: false },
      ],
    });
    expect(unrelatedGetterCalls).toBe(0);
  });
});

describe('browser runtime driver registry', () => {
  it('is provider-neutral, ordered deterministically and duplicate-safe', () => {
    const driver = (driverId: string): BrowserRuntimeDriver => ({
      driverId,
      open: () => {
        throw new Error('not used');
      },
    });
    const registry = new BrowserRuntimeDriverRegistry([
      driver('z-driver'),
      driver('a-driver'),
    ]);
    expect(registry.ids()).toEqual(['a-driver', 'z-driver']);
    expect(registry.require('z-driver').driverId).toBe('z-driver');
    expect(() => registry.register(driver('z-driver'))).toThrow(
      'browser_runtime_driver_already_registered',
    );
    expect(() => registry.require('missing')).toThrow(
      'browser_runtime_driver_not_registered',
    );
  });
});

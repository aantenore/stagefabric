import { z } from 'zod';

import {
  compareBrowserStrings,
  sha256Canonical,
  type Sha256Digest,
} from './crypto.js';

export const BROWSER_RUNTIME_API_VERSION =
  'stagefabric.dev/browser-runtime/v1alpha1' as const;

export const BROWSER_RUNTIME_BINDING_LIMITS = {
  capabilityProbeTimeoutMs: { min: 50, max: 60_000 },
  workerReadyTimeoutMs: { min: 50, max: 60_000 },
  invocationTimeoutMs: { min: 50, max: 300_000 },
  cleanupTimeoutMs: { min: 50, max: 60_000 },
  maxInputBytes: { min: 1, max: 16 * 1_024 * 1_024 },
  maxOutputBytes: { min: 1, max: 16 * 1_024 * 1_024 },
  maxRuntimes: 64,
} as const;

export const BROWSER_RUNTIME_CONFIGURATION_LIMITS = {
  maxDepth: 32,
  maxNodes: 16_385,
  maxKeys: 16_384,
  maxKeyCodeUnits: 256,
  maxStringCodeUnits: 65_536,
  maxTotalStringCodeUnits: 1_048_576,
  maxArrayLength: 4_096,
} as const;

const RESERVED_CONFIGURATION_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

class BrowserRuntimeConfigurationSnapshotError extends Error {}

const safeIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/,
    'must be a safe opaque identifier',
  );
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uniqueSourceIdsSchema = z
  .array(safeIdSchema)
  .max(4_096)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate source identifier',
      });
    }
  })
  .transform((values) =>
    Object.freeze([...values].sort(compareBrowserStrings)),
  );

const workerModuleUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (
      value.includes('\\') ||
      value.startsWith('//') ||
      /^(?:data|blob|javascript|file):/i.test(value)
    ) {
      context.addIssue({ code: 'custom', message: 'unsafe worker module URL' });
      return;
    }

    let url: URL;
    try {
      url = new URL(value, 'https://stagefabric.invalid/');
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'invalid worker module URL',
      });
      return;
    }

    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      context.addIssue({
        code: 'custom',
        message: 'worker module URL must not contain credentials or a fragment',
      });
    }
    if (url.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        message: 'worker module URL must be relative or HTTPS',
      });
    }
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(value) || /%(?:2e|2f|5c)/i.test(value)) {
      context.addIssue({
        code: 'custom',
        message: 'unsafe worker module path',
      });
    }
  });

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxStringCodeUnits),
    z
      .array(jsonValueSchema)
      .max(BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxArrayLength),
    z.record(
      z.string().max(BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxKeyCodeUnits),
      jsonValueSchema,
    ),
  ]),
);

interface ConfigurationSnapshotBudget {
  nodes: number;
  keys: number;
  stringCodeUnits: number;
}

function arrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

/**
 * Takes a bounded JSON snapshot without reading a property through ordinary
 * property access. The depth ceiling is enforced before descending, keeping
 * this pre-Zod traversal stack-safe even for adversarially deep input.
 */
function snapshotConfigurationValue(
  value: unknown,
  budget: ConfigurationSnapshotBudget,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  budget.nodes += 1;
  if (
    budget.nodes > BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxNodes ||
    depth > BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxDepth
  ) {
    throw new BrowserRuntimeConfigurationSnapshotError();
  }

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    return value;
  }
  if (typeof value === 'string') {
    budget.stringCodeUnits += value.length;
    if (
      value.length > BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxStringCodeUnits ||
      budget.stringCodeUnits >
        BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxTotalStringCodeUnits
    ) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new BrowserRuntimeConfigurationSnapshotError();
  }

  const source = value;
  if (ancestors.has(source)) {
    throw new BrowserRuntimeConfigurationSnapshotError();
  }

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(source);
    keys = Reflect.ownKeys(source);
  } catch {
    throw new BrowserRuntimeConfigurationSnapshotError();
  }

  const isArray = Array.isArray(source);
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new BrowserRuntimeConfigurationSnapshotError();
  }

  let dataKeys: readonly string[];
  if (isArray) {
    let lengthDescriptor: PropertyDescriptor | undefined;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(source, 'length');
    } catch {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      (lengthDescriptor.value as number) < 0 ||
      (lengthDescriptor.value as number) >
        BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxArrayLength
    ) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    const length = lengthDescriptor.value as number;
    if (keys.length !== length + 1) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    dataKeys = keys.filter((key): key is string => key !== 'length');
    if (
      dataKeys.length !== length ||
      dataKeys.some(
        (key) => typeof key !== 'string' || !arrayIndex(key, length),
      )
    ) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
  } else {
    if (keys.some((key) => typeof key !== 'string')) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    dataKeys = keys as readonly string[];
  }

  budget.keys += dataKeys.length;
  if (budget.keys > BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxKeys) {
    throw new BrowserRuntimeConfigurationSnapshotError();
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of dataKeys) {
    budget.stringCodeUnits += key.length;
    if (
      key.length > BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxKeyCodeUnits ||
      budget.stringCodeUnits >
        BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxTotalStringCodeUnits ||
      RESERVED_CONFIGURATION_KEYS.has(key)
    ) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      throw new BrowserRuntimeConfigurationSnapshotError();
    }
    descriptors.set(key, descriptor);
  }

  ancestors.add(source);
  try {
    if (isArray) {
      const snapshot = Array.from<unknown>({ length: dataKeys.length });
      for (const key of dataKeys) {
        snapshot[Number(key)] = snapshotConfigurationValue(
          descriptors.get(key)!.value,
          budget,
          ancestors,
          depth + 1,
        );
      }
      return snapshot;
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of dataKeys) {
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: snapshotConfigurationValue(
          descriptors.get(key)!.value,
          budget,
          ancestors,
          depth + 1,
        ),
        writable: true,
      });
    }
    return snapshot;
  } finally {
    ancestors.delete(source);
  }
}

const browserRuntimeConfigurationSchema = z
  .unknown()
  .transform((value, context) => {
    try {
      return snapshotConfigurationValue(
        value,
        { nodes: 0, keys: 0, stringCodeUnits: 0 },
        new WeakSet<object>(),
        0,
      );
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'configuration must be bounded descriptor-safe JSON',
      });
      return z.NEVER;
    }
  })
  .pipe(
    z.record(
      z.string().max(BROWSER_RUNTIME_CONFIGURATION_LIMITS.maxKeyCodeUnits),
      jsonValueSchema,
    ),
  );

export const browserCapabilityRequirementsSchema = z
  .object({
    secureContext: z.boolean(),
    webGpu: z.boolean(),
    wasm: z.boolean(),
  })
  .strict();

export const browserWorkerBindingSchema = z
  .object({
    moduleUrl: workerModuleUrlSchema,
    type: z.literal('module'),
    name: safeIdSchema.optional(),
  })
  .strict();

export const browserRuntimeTargetBindingSchema = z
  .object({
    runtimeId: safeIdSchema,
    driverId: safeIdSchema,
    worker: browserWorkerBindingSchema,
    requirements: browserCapabilityRequirementsSchema,
    configuration: browserRuntimeConfigurationSchema,
  })
  .strict();

export const browserRuntimePolicySchema = z
  .object({
    policyId: safeIdSchema,
    redactionPolicyId: safeIdSchema,
    redactionPolicyDigest: digestSchema,
    redactionRuleIds: uniqueSourceIdsSchema,
    redactionClassifierIds: uniqueSourceIdsSchema,
    egressPolicyId: safeIdSchema,
    egressPolicyDigest: digestSchema,
    capabilityProbeTimeoutMs: z
      .number()
      .int()
      .min(BROWSER_RUNTIME_BINDING_LIMITS.capabilityProbeTimeoutMs.min)
      .max(BROWSER_RUNTIME_BINDING_LIMITS.capabilityProbeTimeoutMs.max),
    workerReadyTimeoutMs: z
      .number()
      .int()
      .min(BROWSER_RUNTIME_BINDING_LIMITS.workerReadyTimeoutMs.min)
      .max(BROWSER_RUNTIME_BINDING_LIMITS.workerReadyTimeoutMs.max),
    invocationTimeoutMs: z
      .number()
      .int()
      .min(BROWSER_RUNTIME_BINDING_LIMITS.invocationTimeoutMs.min)
      .max(BROWSER_RUNTIME_BINDING_LIMITS.invocationTimeoutMs.max),
    cleanupTimeoutMs: z
      .number()
      .int()
      .min(BROWSER_RUNTIME_BINDING_LIMITS.cleanupTimeoutMs.min)
      .max(BROWSER_RUNTIME_BINDING_LIMITS.cleanupTimeoutMs.max),
    maxInputBytes: z
      .number()
      .int()
      .min(BROWSER_RUNTIME_BINDING_LIMITS.maxInputBytes.min)
      .max(BROWSER_RUNTIME_BINDING_LIMITS.maxInputBytes.max),
    maxOutputBytes: z
      .number()
      .int()
      .min(BROWSER_RUNTIME_BINDING_LIMITS.maxOutputBytes.min)
      .max(BROWSER_RUNTIME_BINDING_LIMITS.maxOutputBytes.max),
  })
  .strict()
  .superRefine((policy, context) => {
    const ruleIds = new Set(policy.redactionRuleIds);
    if (policy.redactionClassifierIds.some((id) => ruleIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'redaction source identifiers must be globally unique',
      });
    }
  });

const browserRuntimeBindingsContentShape = {
  apiVersion: z.literal(BROWSER_RUNTIME_API_VERSION),
  kind: z.literal('BrowserRuntimeBindings'),
  operatorId: safeIdSchema,
  policy: browserRuntimePolicySchema,
  runtimes: z
    .array(browserRuntimeTargetBindingSchema)
    .min(1)
    .max(BROWSER_RUNTIME_BINDING_LIMITS.maxRuntimes),
} as const;

function requireUniqueRuntimes(
  bindings: { readonly runtimes: readonly { runtimeId: string }[] },
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, runtime] of bindings.runtimes.entries()) {
    if (seen.has(runtime.runtimeId)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate runtime '${runtime.runtimeId}'`,
        path: ['runtimes', index, 'runtimeId'],
      });
    }
    seen.add(runtime.runtimeId);
  }
}

export const browserRuntimeBindingsContentSchema = z
  .object(browserRuntimeBindingsContentShape)
  .strict()
  .superRefine(requireUniqueRuntimes);

export const browserRuntimeBindingsSchema = z
  .object({
    ...browserRuntimeBindingsContentShape,
    digest: digestSchema,
  })
  .strict()
  .superRefine(requireUniqueRuntimes);

export type BrowserCapabilityRequirements = z.infer<
  typeof browserCapabilityRequirementsSchema
>;
export type BrowserRuntimeTargetBinding = z.infer<
  typeof browserRuntimeTargetBindingSchema
>;
export type BrowserRuntimePolicy = z.infer<typeof browserRuntimePolicySchema>;
export type BrowserRuntimeBindingsContent = z.infer<
  typeof browserRuntimeBindingsContentSchema
>;
export type BrowserRuntimeBindings = z.infer<
  typeof browserRuntimeBindingsSchema
>;

export async function computeBrowserRuntimeBindingsDigest(
  bindings: BrowserRuntimeBindingsContent,
): Promise<Sha256Digest> {
  const parsed = browserRuntimeBindingsContentSchema.parse(bindings);
  return sha256Canonical(parsed);
}

export async function sealBrowserRuntimeBindings(
  bindings: BrowserRuntimeBindingsContent,
): Promise<BrowserRuntimeBindings> {
  const parsed = browserRuntimeBindingsContentSchema.parse(bindings);
  return browserRuntimeBindingsSchema.parse({
    ...parsed,
    digest: await sha256Canonical(parsed),
  });
}

export async function verifyBrowserRuntimeBindings(
  bindings: BrowserRuntimeBindings,
): Promise<boolean> {
  const parsed = browserRuntimeBindingsSchema.safeParse(bindings);
  if (!parsed.success) return false;
  const { digest, ...content } = parsed.data;
  return digest === (await sha256Canonical(content));
}

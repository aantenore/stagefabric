import { z } from 'zod';

import { compareCodePointStrings, sha256Digest } from './canonical.js';
import {
  internalOperationCapability,
  INTERNAL_OPERATION_CAPABILITY_PREFIX,
  sha256DigestSchema,
  STAGEFABRIC_API_VERSION,
} from './schema.js';

export const RUNTIME_BINDINGS_LIMITS = {
  requestTimeoutMs: { min: 100, max: 120_000 },
  maxResponseBytes: { min: 1_024, max: 16 * 1_024 * 1_024 },
  snapshotTtlSeconds: { min: 1, max: 86_400 },
  maxOutputTokens: { min: 1, max: 1_048_576 },
  expectedDimensions: { min: 1, max: 1_048_576 },
} as const;

const safeNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "must contain only letters, digits, '.', '_' or '-'",
  );

const operationNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/,
    'must be a safe operation identifier',
  );

const portNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,63}$/,
    'must start with a lowercase letter and contain only lowercase letters, digits, _ or -',
  );

const capabilitySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (capability) =>
      !capability.startsWith(INTERNAL_OPERATION_CAPABILITY_PREFIX),
    'reserved for StageFabric operation availability evidence',
  );
const modelSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/,
    'must be a safe model identifier',
  );
const environmentVariableSchema = z
  .string()
  .regex(
    /^STAGEFABRIC_[A-Z0-9_]{1,116}$/,
    'must be a dedicated STAGEFABRIC_ environment variable name',
  );

function uniqueStrings(schema: z.ZodType<string>) {
  return z
    .array(schema)
    .min(1)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate value '${value}'`,
            path: [index],
          });
        }
        seen.add(value);
      }
    });
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;

  const octets = hostname.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet))) {
    return false;
  }
  const numbers = octets.map(Number);
  return numbers[0] === 127 && numbers.every((octet) => octet <= 255);
}

function canonicalizeBaseUrl(value: string, context: z.RefinementCtx) {
  const schemeEnd = value.indexOf('://');
  const pathStart = schemeEnd === -1 ? -1 : value.indexOf('/', schemeEnd + 3);
  const rawPath =
    pathStart === -1 ? '' : value.slice(pathStart).split(/[?#]/, 1)[0]!;
  if (
    value.includes('\\') ||
    /%(?:2e|2f|5c)/i.test(value) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)
  ) {
    context.addIssue({ code: 'custom', message: 'must use a safe raw path' });
    return z.NEVER;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'must be a valid URL' });
    return z.NEVER;
  }

  if (url.username !== '' || url.password !== '') {
    context.addIssue({
      code: 'custom',
      message: 'must not contain credentials',
    });
  }
  if (url.search !== '' || url.hash !== '') {
    context.addIssue({
      code: 'custom',
      message: 'must not contain a query or fragment',
    });
  }

  const isHttps = url.protocol === 'https:';
  const isLoopbackHttp =
    url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!isHttps && !isLoopbackHttp) {
    context.addIssue({
      code: 'custom',
      message: 'must use HTTPS, except for literal loopback or localhost HTTP',
    });
  }

  if (url.pathname.includes('/../') || url.pathname.endsWith('/..')) {
    context.addIssue({ code: 'custom', message: 'must not traverse paths' });
  }

  if (context.issues.length > 0) return z.NEVER;

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export const runtimeProviderSchema = z
  .object({
    kind: z.literal('openai-compatible'),
    name: safeNameSchema,
    baseUrl: z.string().trim().transform(canonicalizeBaseUrl),
    apiKeyEnv: environmentVariableSchema.optional(),
  })
  .strict();

const operationBaseShape = {
  operation: operationNameSchema,
  capabilities: uniqueStrings(capabilitySchema),
  model: modelSchema,
  input: portNameSchema,
  output: portNameSchema,
} as const;

export const generateTextBindingSchema = z
  .object({
    kind: z.literal('generate-text'),
    ...operationBaseShape,
    systemPrompt: z.string().trim().min(1).max(32_768).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z
      .number()
      .int()
      .min(RUNTIME_BINDINGS_LIMITS.maxOutputTokens.min)
      .max(RUNTIME_BINDINGS_LIMITS.maxOutputTokens.max)
      .optional(),
  })
  .strict();

export const embeddingBindingSchema = z
  .object({
    kind: z.literal('embedding'),
    ...operationBaseShape,
    expectedDimensions: z
      .number()
      .int()
      .min(RUNTIME_BINDINGS_LIMITS.expectedDimensions.min)
      .max(RUNTIME_BINDINGS_LIMITS.expectedDimensions.max),
  })
  .strict();

export const runtimeOperationBindingSchema = z.discriminatedUnion('kind', [
  generateTextBindingSchema,
  embeddingBindingSchema,
]);

export const runtimeTargetBindingSchema = z
  .object({
    targetId: safeNameSchema,
    provider: runtimeProviderSchema,
    operations: z.array(runtimeOperationBindingSchema).min(1),
  })
  .strict()
  .superRefine((target, context) => {
    const seen = new Set<string>();
    for (const [index, operation] of target.operations.entries()) {
      if (seen.has(operation.operation)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate operation '${operation.operation}'`,
          path: ['operations', index, 'operation'],
        });
      }
      seen.add(operation.operation);
    }
  });

export const runtimeBindingsPolicySchema = z
  .object({
    requestTimeoutMs: z
      .number()
      .int()
      .min(RUNTIME_BINDINGS_LIMITS.requestTimeoutMs.min)
      .max(RUNTIME_BINDINGS_LIMITS.requestTimeoutMs.max),
    maxResponseBytes: z
      .number()
      .int()
      .min(RUNTIME_BINDINGS_LIMITS.maxResponseBytes.min)
      .max(RUNTIME_BINDINGS_LIMITS.maxResponseBytes.max),
    snapshotTtlSeconds: z
      .number()
      .int()
      .min(RUNTIME_BINDINGS_LIMITS.snapshotTtlSeconds.min)
      .max(RUNTIME_BINDINGS_LIMITS.snapshotTtlSeconds.max),
  })
  .strict();

const runtimeBindingsContentShape = {
  apiVersion: z.literal(STAGEFABRIC_API_VERSION),
  kind: z.literal('RuntimeBindings'),
  policy: runtimeBindingsPolicySchema,
  targets: z.array(runtimeTargetBindingSchema).min(1),
} as const;

function requireUniqueTargets(
  bindings: { targets: readonly { targetId: string }[] },
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, target] of bindings.targets.entries()) {
    if (seen.has(target.targetId)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate target '${target.targetId}'`,
        path: ['targets', index, 'targetId'],
      });
    }
    seen.add(target.targetId);
  }
}

export const runtimeBindingsContentSchema = z
  .object(runtimeBindingsContentShape)
  .strict()
  .superRefine(requireUniqueTargets);

export const runtimeBindingsSchema = z
  .object({
    ...runtimeBindingsContentShape,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine(requireUniqueTargets);

export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;
export type GenerateTextBinding = z.infer<typeof generateTextBindingSchema>;
export type EmbeddingBinding = z.infer<typeof embeddingBindingSchema>;
export type RuntimeOperationBinding = z.infer<
  typeof runtimeOperationBindingSchema
>;
export type RuntimeTargetBinding = z.infer<typeof runtimeTargetBindingSchema>;
export type RuntimeBindingsPolicy = z.infer<typeof runtimeBindingsPolicySchema>;
export type RuntimeBindingsContent = z.infer<
  typeof runtimeBindingsContentSchema
>;
export type RuntimeBindings = z.infer<typeof runtimeBindingsSchema>;

/**
 * Internal placement guard derived by the trusted runner. It is not a
 * caller-declared capability and grants no authority: the probe advertises it
 * only after observing the exact operation model.
 */
export function runtimeOperationCapability(operation: string): string {
  return internalOperationCapability(operation);
}

function normalizedOperation(
  operation: RuntimeOperationBinding,
): RuntimeOperationBinding {
  const common = {
    operation: operation.operation,
    capabilities: [...operation.capabilities].sort(compareCodePointStrings),
    model: operation.model,
    input: operation.input,
    output: operation.output,
  };
  if (operation.kind === 'embedding') {
    return {
      kind: 'embedding',
      ...common,
      expectedDimensions: operation.expectedDimensions,
    };
  }
  return {
    kind: 'generate-text',
    ...common,
    ...(operation.systemPrompt !== undefined
      ? { systemPrompt: operation.systemPrompt }
      : {}),
    ...(operation.temperature !== undefined
      ? { temperature: operation.temperature }
      : {}),
    ...(operation.maxOutputTokens !== undefined
      ? { maxOutputTokens: operation.maxOutputTokens }
      : {}),
  };
}

function normalizedRuntimeBindingsContent(
  content: RuntimeBindingsContent,
): RuntimeBindingsContent {
  return {
    apiVersion: content.apiVersion,
    kind: content.kind,
    policy: {
      requestTimeoutMs: content.policy.requestTimeoutMs,
      maxResponseBytes: content.policy.maxResponseBytes,
      snapshotTtlSeconds: content.policy.snapshotTtlSeconds,
    },
    targets: [...content.targets]
      .map((target) => ({
        targetId: target.targetId,
        provider: {
          kind: target.provider.kind,
          name: target.provider.name,
          baseUrl: target.provider.baseUrl,
          ...(target.provider.apiKeyEnv === undefined
            ? {}
            : { apiKeyEnv: target.provider.apiKeyEnv }),
        },
        operations: [...target.operations]
          .map(normalizedOperation)
          .sort((left, right) =>
            compareCodePointStrings(left.operation, right.operation),
          ),
      }))
      .sort((left, right) =>
        compareCodePointStrings(left.targetId, right.targetId),
      ),
  };
}

export function computeRuntimeBindingsDigest(
  input: unknown,
): `sha256:${string}` {
  const content = runtimeBindingsContentSchema.parse(input);
  return sha256Digest(normalizedRuntimeBindingsContent(content));
}

export function sealRuntimeBindings(input: unknown): RuntimeBindings {
  const content = runtimeBindingsContentSchema.parse(input);
  return runtimeBindingsSchema.parse({
    ...content,
    digest: computeRuntimeBindingsDigest(content),
  });
}

export function verifyRuntimeBindingsDigest(
  bindings: RuntimeBindings,
): boolean {
  const { digest, ...content } = bindings;
  return digest === computeRuntimeBindingsDigest(content);
}

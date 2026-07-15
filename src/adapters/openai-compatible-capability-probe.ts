import { z } from 'zod';

import { compareCodePointStrings } from '../domain/canonical.js';
import {
  runtimeOperationCapability,
  runtimeBindingsSchema,
  runtimeBindingsPolicySchema,
  runtimeTargetBindingSchema,
  verifyRuntimeBindingsDigest,
  type RuntimeBindingsPolicy,
  type RuntimeTargetBinding,
} from '../domain/runtime-bindings.js';
import {
  timestampSchema,
  type CapabilitySnapshot,
  type CapabilityTargetState,
} from '../domain/schema.js';
import { sealCapabilitySnapshot } from '../domain/snapshot.js';
import { createBoundedFetch } from './bounded-fetch.js';

const modelsResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
          })
          // OpenAI-compatible servers attach different metadata to a model
          // card. Only the bounded id projection is placement evidence.
          .strip(),
      )
      .max(100_000),
  })
  // Ignore bounded, non-authoritative envelope metadata such as `object`.
  .strip();

const capabilityProbePolicySchema = runtimeBindingsPolicySchema.pick({
  requestTimeoutMs: true,
  maxResponseBytes: true,
});

export type CapabilityProbeErrorCode =
  'bindings_invalid' | 'binding_digest_mismatch' | 'timestamp_invalid';

/** Stable configuration error that never embeds bindings, endpoints or secrets. */
export class CapabilityProbeError extends Error {
  readonly code: CapabilityProbeErrorCode;

  constructor(code: CapabilityProbeErrorCode) {
    super(code);
    this.name = 'CapabilityProbeError';
    this.code = code;
  }
}

export interface BearerTokenRequest {
  readonly targetId: string;
  readonly providerName: string;
  readonly apiKeyEnv: string;
}

export type BearerTokenResolver = (
  request: BearerTokenRequest,
) => Promise<string | undefined> | string | undefined;

export interface OpenAICompatibleCapabilityProbeOptions {
  readonly target: RuntimeTargetBinding;
  readonly policy: Pick<
    RuntimeBindingsPolicy,
    'requestTimeoutMs' | 'maxResponseBytes'
  >;
  readonly fetch: typeof globalThis.fetch;
  readonly bearerToken?: string;
}

function unavailableTarget(targetId: string): CapabilityTargetState {
  return { targetId, healthy: false, capabilities: [] };
}

function usableBearerToken(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.trim() !== '' &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

/**
 * Probes exactly one trusted OpenAI-compatible target. Upstream failures are
 * deliberately collapsed into a content-free unhealthy state.
 */
export async function probeOpenAICompatibleCapabilities(
  options: OpenAICompatibleCapabilityProbeOptions,
): Promise<CapabilityTargetState> {
  const parsedTarget = runtimeTargetBindingSchema.safeParse(options.target);
  const parsedPolicy = capabilityProbePolicySchema.safeParse({
    requestTimeoutMs: options.policy.requestTimeoutMs,
    maxResponseBytes: options.policy.maxResponseBytes,
  });
  if (!parsedTarget.success || !parsedPolicy.success) {
    throw new CapabilityProbeError('bindings_invalid');
  }
  const target = parsedTarget.data;
  try {
    if (target.provider.apiKeyEnv !== undefined) {
      if (!usableBearerToken(options.bearerToken)) {
        return unavailableTarget(target.targetId);
      }
    } else if (options.bearerToken !== undefined) {
      return unavailableTarget(target.targetId);
    }

    const boundedFetch = createBoundedFetch({
      baseUrl: target.provider.baseUrl,
      allowedPathnames: [new URL(`${target.provider.baseUrl}/models`).pathname],
      timeoutMs: parsedPolicy.data.requestTimeoutMs,
      maxResponseBytes: parsedPolicy.data.maxResponseBytes,
      fetch: options.fetch,
    });
    const headers = new Headers({ accept: 'application/json' });
    if (options.bearerToken !== undefined) {
      headers.set('authorization', `Bearer ${options.bearerToken}`);
    }

    const response = await boundedFetch(`${target.provider.baseUrl}/models`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) return unavailableTarget(target.targetId);

    const parsed = modelsResponseSchema.safeParse(await response.json());
    if (!parsed.success) return unavailableTarget(target.targetId);

    const models = new Set(parsed.data.data.map((model) => model.id));
    const capabilities = [
      ...new Set(
        target.operations.flatMap((operation) =>
          models.has(operation.model)
            ? [
                ...operation.capabilities,
                runtimeOperationCapability(operation.operation),
              ]
            : [],
        ),
      ),
    ].sort(compareCodePointStrings);

    return { targetId: target.targetId, healthy: true, capabilities };
  } catch {
    return unavailableTarget(target.targetId);
  }
}

export interface ProbeRuntimeBindingsOptions {
  /** A sealed RuntimeBindings value; unsealed or tampered input is rejected. */
  readonly bindings: unknown;
  /** Required clock input. It is normalized to UTC before TTL calculation. */
  readonly observedAt: string;
  /** Explicitly injected I/O implementation; production may pass globalThis.fetch. */
  readonly fetch: typeof globalThis.fetch;
  /** Resolves only symbolic apiKeyEnv references. Tokens never enter output. */
  readonly resolveBearerToken?: BearerTokenResolver;
}

/**
 * Produces a sealed, bindings-bound snapshot. `expiresAt` is deterministically
 * derived as `observedAt + snapshotTtlSeconds`.
 */
export async function probeRuntimeBindings(
  options: ProbeRuntimeBindingsOptions,
): Promise<CapabilitySnapshot> {
  const parsedBindings = runtimeBindingsSchema.safeParse(options.bindings);
  if (!parsedBindings.success) {
    throw new CapabilityProbeError('bindings_invalid');
  }

  if (!verifyRuntimeBindingsDigest(parsedBindings.data)) {
    throw new CapabilityProbeError('binding_digest_mismatch');
  }

  const parsedTimestamp = timestampSchema.safeParse(options.observedAt);
  if (!parsedTimestamp.success) {
    throw new CapabilityProbeError('timestamp_invalid');
  }
  const observedEpoch = Date.parse(parsedTimestamp.data);
  const observedAt = new Date(observedEpoch).toISOString();
  const expiresAt = new Date(
    observedEpoch + parsedBindings.data.policy.snapshotTtlSeconds * 1_000,
  ).toISOString();

  const targets = await Promise.all(
    parsedBindings.data.targets.map(async (target) => {
      let bearerToken: string | undefined;
      if (target.provider.apiKeyEnv !== undefined) {
        if (options.resolveBearerToken === undefined) {
          return unavailableTarget(target.targetId);
        }
        try {
          bearerToken = await options.resolveBearerToken({
            targetId: target.targetId,
            providerName: target.provider.name,
            apiKeyEnv: target.provider.apiKeyEnv,
          });
        } catch {
          return unavailableTarget(target.targetId);
        }
      }

      return probeOpenAICompatibleCapabilities({
        target,
        policy: {
          requestTimeoutMs: parsedBindings.data.policy.requestTimeoutMs,
          maxResponseBytes: parsedBindings.data.policy.maxResponseBytes,
        },
        fetch: options.fetch,
        ...(bearerToken === undefined ? {} : { bearerToken }),
      });
    }),
  );

  return sealCapabilitySnapshot({
    apiVersion: parsedBindings.data.apiVersion,
    kind: 'CapabilitySnapshot',
    bindingDigest: parsedBindings.data.digest,
    observedAt,
    expiresAt,
    targets,
  });
}

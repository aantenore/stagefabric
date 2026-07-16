import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, embed, generateText } from 'ai';
import { z } from 'zod';

import { sha256Digest } from '../domain/canonical.js';
import {
  runtimeBindingsPolicySchema,
  runtimeOperationBindingSchema,
  runtimeTargetBindingSchema,
  type RuntimeOperationBinding,
} from '../domain/runtime-bindings.js';
import {
  RUNTIME_QUALIFICATION_LIMITS,
  type RuntimeQualificationReasonCode,
} from '../domain/runtime-qualification.js';
import type {
  RuntimeOperationQualification,
  RuntimeOperationQualifier,
  RuntimeOperationQualifierRequest,
} from '../ports/runtime-operation-qualifier.js';
import { BoundedFetchError, createBoundedFetch } from './bounded-fetch.js';

const SYNTHETIC_TEXT = 'OK';
const SYNTHETIC_SYSTEM_TEXT = 'Return exactly OK.';
const SYNTHETIC_EMBEDDING_INPUT = 'OK';

const modelsResponseSchema = z
  .object({
    data: z
      .array(z.object({ id: z.string().min(1).max(256) }).strip())
      .max(100_000),
  })
  .strip();

const qualificationPolicySchema = runtimeBindingsPolicySchema
  .pick({
    requestTimeoutMs: true,
    maxResponseBytes: true,
  })
  .extend({
    maxGenerationOutputTokensPerCall: z
      .number()
      .int()
      .min(RUNTIME_QUALIFICATION_LIMITS.maxGenerationOutputTokensPerCall.min)
      .max(RUNTIME_QUALIFICATION_LIMITS.maxGenerationOutputTokensPerCall.max),
  });

export class OpenAICompatibleQualificationError extends Error {
  readonly code = 'qualification_request_invalid';

  constructor() {
    super('qualification_request_invalid');
    this.name = 'OpenAICompatibleQualificationError';
  }
}

export interface OpenAICompatibleRuntimeOperationQualifierOptions {
  readonly fetch?: typeof globalThis.fetch;
}

interface ModelObservation {
  readonly models?: ReadonlySet<string>;
  readonly reasonCode?: Exclude<RuntimeQualificationReasonCode, 'qualified'>;
}

function usableCredential(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.trim() !== '' &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function boundedFetchCause(error: unknown): BoundedFetchError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof BoundedFetchError) return current;
    if (
      typeof current !== 'object' ||
      current === null ||
      seen.has(current) ||
      !('cause' in current)
    ) {
      return undefined;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

function boundedReason(
  error: unknown,
): Exclude<RuntimeQualificationReasonCode, 'qualified'> | undefined {
  const bounded = boundedFetchCause(error);
  switch (bounded?.code) {
    case 'request_aborted':
      return 'deadline_exceeded';
    case 'request_timeout':
      return 'request_timeout';
    case 'request_rejected':
    case 'invalid_configuration':
      return 'request_rejected';
    case 'upstream_redirect':
      return 'upstream_redirect';
    case 'upstream_response_invalid':
      return 'response_invalid';
    case 'upstream_response_too_large':
      return 'response_too_large';
    case 'network_failure':
      return 'network_failure';
    case undefined:
      return undefined;
  }
}

function providerReason(
  error: unknown,
  phase: 'discovery' | 'operation',
): Exclude<RuntimeQualificationReasonCode, 'qualified'> {
  const bounded = boundedReason(error);
  if (bounded !== undefined) return bounded;
  if (APICallError.isInstance(error)) {
    return error.statusCode !== undefined && error.statusCode >= 400
      ? phase === 'discovery'
        ? 'provider_rejected'
        : 'operation_rejected'
      : 'operation_output_invalid';
  }
  return phase === 'discovery'
    ? 'response_invalid'
    : 'operation_output_invalid';
}

function rejected(
  operation: RuntimeOperationBinding,
  reasonCode: Exclude<RuntimeQualificationReasonCode, 'qualified'>,
): RuntimeOperationQualification {
  return {
    operation: operation.operation,
    operationKind: operation.kind,
    status: 'rejected',
    reasonCode,
  };
}

function qualified(
  operation: RuntimeOperationBinding,
): RuntimeOperationQualification {
  return {
    operation: operation.operation,
    operationKind: operation.kind,
    status: 'qualified',
    reasonCode: 'qualified',
  };
}

function exactSelectedOperations(
  request: RuntimeOperationQualifierRequest,
  target: z.infer<typeof runtimeTargetBindingSchema>,
): readonly RuntimeOperationBinding[] {
  const parsedOperations = z
    .array(runtimeOperationBindingSchema)
    .min(1)
    .max(1_024)
    .safeParse(request.operations);
  if (!parsedOperations.success) {
    throw new OpenAICompatibleQualificationError();
  }
  const bound = new Map(
    target.operations.map((operation) => [operation.operation, operation]),
  );
  const selected: RuntimeOperationBinding[] = [];
  const seen = new Set<string>();
  for (const candidate of parsedOperations.data) {
    const expected = bound.get(candidate.operation);
    if (
      expected === undefined ||
      seen.has(candidate.operation) ||
      sha256Digest(candidate) !== sha256Digest(expected)
    ) {
      throw new OpenAICompatibleQualificationError();
    }
    seen.add(candidate.operation);
    selected.push(expected);
  }
  return selected;
}

async function observeModels(
  boundedFetch: typeof globalThis.fetch,
  baseUrl: string,
  headers: Headers,
  signal: AbortSignal,
): Promise<ModelObservation> {
  try {
    const response = await boundedFetch(`${baseUrl}/models`, {
      method: 'GET',
      headers,
      signal,
    });
    if (!response.ok) return { reasonCode: 'provider_rejected' };
    const parsed = modelsResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { models: new Set(parsed.data.data.map((model) => model.id)) }
      : { reasonCode: 'response_invalid' };
  } catch (error) {
    return { reasonCode: providerReason(error, 'discovery') };
  }
}

async function qualifyOperation(
  provider: ReturnType<typeof createOpenAICompatible>,
  operation: RuntimeOperationBinding,
  maxGenerationOutputTokensPerCall: number,
  signal: AbortSignal,
): Promise<Exclude<RuntimeQualificationReasonCode, 'qualified'> | undefined> {
  if (signal.aborted) return 'deadline_exceeded';
  try {
    if (operation.kind === 'generate-text') {
      if (
        operation.maxOutputTokens === undefined ||
        operation.maxOutputTokens > maxGenerationOutputTokensPerCall
      ) {
        return 'operation_configuration_unqualified';
      }
      const result = await generateText({
        model: provider.chatModel(operation.model),
        prompt: SYNTHETIC_TEXT,
        ...(operation.systemPrompt === undefined
          ? {}
          : { instructions: SYNTHETIC_SYSTEM_TEXT }),
        ...(operation.temperature === undefined
          ? {}
          : { temperature: operation.temperature }),
        maxOutputTokens: operation.maxOutputTokens,
        maxRetries: 0,
        abortSignal: signal,
        telemetry: {
          isEnabled: false,
          recordInputs: false,
          recordOutputs: false,
        },
      });
      if (result.toolCalls.length > 0 || result.text.trim().length === 0) {
        return 'operation_output_invalid';
      }
      return undefined;
    }

    const result = await embed({
      model: provider.embeddingModel(operation.model),
      value: SYNTHETIC_EMBEDDING_INPUT,
      maxRetries: 0,
      abortSignal: signal,
      telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
    });
    return result.embedding.length === operation.expectedDimensions &&
      result.embedding.every(Number.isFinite)
      ? undefined
      : 'operation_output_invalid';
  } catch (error) {
    return providerReason(error, 'operation');
  }
}

function configurationQualified(
  operation: RuntimeOperationBinding,
  maxGenerationOutputTokensPerCall: number,
): boolean {
  return (
    operation.kind === 'embedding' ||
    (operation.maxOutputTokens !== undefined &&
      operation.maxOutputTokens <= maxGenerationOutputTokensPerCall)
  );
}

/**
 * Opt-in OpenAI-compatible qualifier. For an admitted request it performs one
 * `/models` call followed by one non-streaming synthetic call for each admitted
 * operation. Generation preserves bounded configuration knobs while replacing
 * user and system content. It never retries and never exposes provider data.
 */
export class OpenAICompatibleRuntimeOperationQualifier implements RuntimeOperationQualifier {
  readonly kind = 'openai-compatible';
  readonly version = '1';
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleRuntimeOperationQualifierOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async qualify(
    request: RuntimeOperationQualifierRequest,
  ): Promise<readonly RuntimeOperationQualification[]> {
    const parsedTarget = runtimeTargetBindingSchema.safeParse(request.target);
    const parsedPolicy = qualificationPolicySchema.safeParse(request.policy);
    if (!parsedTarget.success || !parsedPolicy.success) {
      throw new OpenAICompatibleQualificationError();
    }
    const target = parsedTarget.data;
    const operations = exactSelectedOperations(request, target);
    const maxGenerationOutputTokensPerCall =
      parsedPolicy.data.maxGenerationOutputTokensPerCall;
    const runnableOperations = operations.filter((operation) =>
      configurationQualified(operation, maxGenerationOutputTokensPerCall),
    );

    if (runnableOperations.length === 0) {
      return operations.map((operation) =>
        rejected(operation, 'operation_configuration_unqualified'),
      );
    }

    const credentialRequired = target.provider.apiKeyEnv !== undefined;
    if (
      (credentialRequired && !usableCredential(request.credential)) ||
      (!credentialRequired && request.credential !== undefined)
    ) {
      return operations.map((operation) =>
        rejected(
          operation,
          configurationQualified(operation, maxGenerationOutputTokensPerCall)
            ? 'credential_unavailable'
            : 'operation_configuration_unqualified',
        ),
      );
    }

    const suffixes = new Set(['models']);
    for (const operation of runnableOperations) {
      suffixes.add(
        operation.kind === 'generate-text' ? 'chat/completions' : 'embeddings',
      );
    }
    const boundedFetch = createBoundedFetch({
      baseUrl: target.provider.baseUrl,
      allowedPathnames: [...suffixes].map(
        (suffix) => new URL(`${target.provider.baseUrl}/${suffix}`).pathname,
      ),
      timeoutMs: parsedPolicy.data.requestTimeoutMs,
      maxResponseBytes: parsedPolicy.data.maxResponseBytes,
      fetch: this.#fetch,
    });
    const headers = new Headers({ accept: 'application/json' });
    if (request.credential !== undefined) {
      headers.set('authorization', `Bearer ${request.credential}`);
    }
    const provider = createOpenAICompatible({
      name: target.provider.name,
      baseURL: target.provider.baseUrl,
      ...(request.credential === undefined
        ? {}
        : { apiKey: request.credential }),
      fetch: boundedFetch,
    });

    const observation = await observeModels(
      boundedFetch,
      target.provider.baseUrl,
      headers,
      request.signal,
    );
    const results: RuntimeOperationQualification[] = [];
    for (const operation of operations) {
      if (
        !configurationQualified(operation, maxGenerationOutputTokensPerCall)
      ) {
        results.push(
          rejected(operation, 'operation_configuration_unqualified'),
        );
        continue;
      }
      const operationReason = await qualifyOperation(
        provider,
        operation,
        maxGenerationOutputTokensPerCall,
        request.signal,
      );
      const reasonCode =
        observation.reasonCode ??
        (observation.models?.has(operation.model) === true
          ? operationReason
          : 'model_unavailable');
      results.push(
        reasonCode === undefined
          ? qualified(operation)
          : rejected(operation, reasonCode),
      );
    }
    return results;
  }
}

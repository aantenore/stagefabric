import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, embed, generateText } from 'ai';

import {
  runtimeBindingsSchema,
  verifyRuntimeBindingsDigest,
  type RuntimeBindings,
  type RuntimeOperationBinding,
  type RuntimeTargetBinding,
} from '../domain/runtime-bindings.js';
import {
  StageAdapterError,
  type StageAdapter,
  type StageAdapterRequest,
  type StageAdapterResult,
} from '../ports/stage-adapter.js';
import { BoundedFetchError, createBoundedFetch } from './bounded-fetch.js';

const RETRYABLE_PRE_OUTPUT_STATUSES = new Set([429, 502, 503, 504]);

export interface OpenAICompatibleStageAdapterOptions {
  readonly bindings: RuntimeBindings;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

interface BoundOperation {
  readonly target: RuntimeTargetBinding;
  readonly operation: RuntimeOperationBinding;
}

function adapterFailure(): StageAdapterError {
  return new StageAdapterError({
    code: 'adapter_failure',
    outputEmitted: false,
  });
}

function usableApiKey(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.trim() !== '' &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function boundedFetchCause(error: unknown): BoundedFetchError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof BoundedFetchError) {
      return current;
    }
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

function normalizeProviderError(error: unknown): StageAdapterError {
  const bounded = boundedFetchCause(error);
  if (bounded?.code === 'request_timeout') {
    return new StageAdapterError({ code: 'timeout', outputEmitted: false });
  }

  const statusCode = APICallError.isInstance(error)
    ? error.statusCode
    : bounded?.statusCode;
  if (
    statusCode !== undefined &&
    RETRYABLE_PRE_OUTPUT_STATUSES.has(statusCode)
  ) {
    return new StageAdapterError({
      code: statusCode === 429 ? 'upstream_rejected' : 'upstream_unavailable',
      statusCode,
      outputEmitted: false,
    });
  }

  return adapterFailure();
}

function boundOperations(
  bindings: RuntimeBindings,
): ReadonlyMap<string, ReadonlyMap<string, BoundOperation>> {
  const targets = new Map<string, ReadonlyMap<string, BoundOperation>>();
  for (const target of bindings.targets) {
    const operations = new Map<string, BoundOperation>();
    for (const operation of target.operations) {
      operations.set(operation.operation, { target, operation });
    }
    targets.set(target.targetId, operations);
  }
  return targets;
}

/**
 * Executes only operations sealed into trusted runtime bindings. Provider
 * endpoints and symbolic credential references never come from a graph or plan.
 */
export class OpenAICompatibleStageAdapter implements StageAdapter {
  readonly kind = 'openai-compatible';
  readonly #bindings: RuntimeBindings;
  readonly #operations: ReadonlyMap<
    string,
    ReadonlyMap<string, BoundOperation>
  >;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleStageAdapterOptions) {
    const parsed = runtimeBindingsSchema.safeParse(options.bindings);
    if (!parsed.success || !verifyRuntimeBindingsDigest(parsed.data)) {
      throw adapterFailure();
    }
    this.#bindings = parsed.data;
    this.#operations = boundOperations(parsed.data);
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async execute(request: StageAdapterRequest): Promise<StageAdapterResult> {
    const bound = this.#operations
      .get(request.targetId)
      ?.get(request.operation);
    if (bound === undefined) {
      throw adapterFailure();
    }

    const { target, operation } = bound;
    if (
      !hasExactKeys(request.inputs, [operation.input]) ||
      request.expectedOutputs.length !== 1 ||
      request.expectedOutputs[0] !== operation.output
    ) {
      throw adapterFailure();
    }
    const input = request.inputs[operation.input];
    if (typeof input !== 'string') {
      throw adapterFailure();
    }

    let apiKey: string | undefined;
    if (target.provider.apiKeyEnv !== undefined) {
      const resolved = this.#environment[target.provider.apiKeyEnv];
      if (!usableApiKey(resolved)) {
        throw adapterFailure();
      }
      apiKey = resolved;
    }

    const boundedFetch = createBoundedFetch({
      baseUrl: target.provider.baseUrl,
      allowedPathnames: [
        new URL(
          `${target.provider.baseUrl}/${
            operation.kind === 'generate-text'
              ? 'chat/completions'
              : 'embeddings'
          }`,
        ).pathname,
      ],
      timeoutMs: this.#bindings.policy.requestTimeoutMs,
      maxResponseBytes: this.#bindings.policy.maxResponseBytes,
      fetch: this.#fetch,
    });
    const provider = createOpenAICompatible({
      name: target.provider.name,
      baseURL: target.provider.baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      fetch: boundedFetch,
    });

    try {
      if (operation.kind === 'generate-text') {
        const result = await generateText({
          model: provider.chatModel(operation.model),
          prompt: input,
          ...(operation.systemPrompt === undefined
            ? {}
            : { instructions: operation.systemPrompt }),
          ...(operation.temperature === undefined
            ? {}
            : { temperature: operation.temperature }),
          ...(operation.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: operation.maxOutputTokens }),
          maxRetries: 0,
          telemetry: {
            isEnabled: false,
            recordInputs: false,
            recordOutputs: false,
          },
        });
        if (result.toolCalls.length > 0 || result.text.trim().length === 0) {
          throw adapterFailure();
        }
        return { outputs: { [operation.output]: result.text } };
      }

      const result = await embed({
        model: provider.embeddingModel(operation.model),
        value: input,
        maxRetries: 0,
        telemetry: {
          isEnabled: false,
          recordInputs: false,
          recordOutputs: false,
        },
      });
      if (
        result.embedding.length !== operation.expectedDimensions ||
        !result.embedding.every(Number.isFinite)
      ) {
        throw adapterFailure();
      }
      return { outputs: { [operation.output]: result.embedding } };
    } catch (error) {
      if (error instanceof StageAdapterError) {
        throw error;
      }
      throw normalizeProviderError(error);
    }
  }
}

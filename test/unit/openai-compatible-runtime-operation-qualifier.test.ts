import { describe, expect, it, vi } from 'vitest';

import {
  OpenAICompatibleQualificationError,
  OpenAICompatibleRuntimeOperationQualifier,
} from '../../src/adapters/openai-compatible-runtime-operation-qualifier.js';
import {
  sealRuntimeBindings,
  type RuntimeBindings,
} from '../../src/domain/runtime-bindings.js';

const API_KEY = 'sk-qualification-adapter-sentinel';
const CONFIGURED_PROMPT = 'never send this configured system prompt';
const RAW_ERROR = 'raw-upstream-error-sentinel';

function bindings(authenticated = true): RuntimeBindings {
  return sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 1_000,
      maxResponseBytes: 16_384,
      snapshotTtlSeconds: 60,
    },
    targets: [
      {
        targetId: 'runtime-a',
        provider: {
          kind: 'openai-compatible',
          name: 'runtime-provider',
          baseUrl: 'https://runtime.invalid/v1',
          ...(authenticated
            ? { apiKeyEnv: 'STAGEFABRIC_RUNTIME_API_KEY' }
            : {}),
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'generate',
            capabilities: ['text-generation'],
            model: 'text-model',
            input: 'prompt',
            output: 'text',
            systemPrompt: CONFIGURED_PROMPT,
            temperature: 1.5,
            maxOutputTokens: 500,
          },
          {
            kind: 'embedding',
            operation: 'embed',
            capabilities: ['embedding'],
            model: 'embedding-model',
            input: 'text',
            output: 'vector',
            expectedDimensions: 3,
          },
        ],
      },
    ],
  });
}

function request(
  sealed = bindings(),
  overrides: Partial<{
    operations: (typeof sealed.targets)[0]['operations'];
    credential: string;
    signal: AbortSignal;
    requestTimeoutMs: number;
    maxResponseBytes: number;
    maxGenerationOutputTokensPerCall: number;
  }> = {},
) {
  return {
    target: sealed.targets[0]!,
    operations: overrides.operations ?? sealed.targets[0]!.operations,
    policy: {
      requestTimeoutMs: overrides.requestTimeoutMs ?? 1_000,
      maxResponseBytes: overrides.maxResponseBytes ?? 16_384,
      maxGenerationOutputTokensPerCall:
        overrides.maxGenerationOutputTokensPerCall ?? 512,
    },
    ...(overrides.credential === undefined
      ? { credential: API_KEY }
      : { credential: overrides.credential }),
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

async function requestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Record<string, unknown>> {
  if (input instanceof Request) {
    return (await input.clone().json()) as Record<string, unknown>;
  }
  if (typeof init?.body !== 'string') throw new Error('expected_string_body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function textResponse(text = 'K') {
  return Response.json({
    choices: [
      {
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
  });
}

function embeddingResponse(vector: readonly number[] = [0.1, 0.2, 0.3]) {
  return Response.json({
    data: [{ embedding: vector }],
    usage: { prompt_tokens: 1 },
  });
}

describe('OpenAI-compatible runtime operation qualifier', () => {
  it('uses one discovery and preserves bounded generation knobs with synthetic content', async () => {
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(requestUrl(input));
      paths.push(url.pathname);
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${API_KEY}`,
      );

      if (url.pathname === '/v1/models') {
        expect(init?.method).toBe('GET');
        return Response.json({
          data: [{ id: 'text-model' }, { id: 'embedding-model' }],
        });
      }
      const body = await requestBody(input, init);
      if (url.pathname === '/v1/chat/completions') {
        expect(body).toMatchObject({
          model: 'text-model',
          max_tokens: 500,
          temperature: 1.5,
          messages: [
            { role: 'system', content: 'Reply with OK.' },
            { role: 'user', content: 'OK' },
          ],
        });
        expect(JSON.stringify(body)).not.toContain(CONFIGURED_PROMPT);
        return textResponse();
      }
      expect(url.pathname).toBe('/v1/embeddings');
      expect(body).toMatchObject({
        model: 'embedding-model',
        input: ['OK'],
        encoding_format: 'float',
      });
      return embeddingResponse();
    });

    const qualifier = new OpenAICompatibleRuntimeOperationQualifier({ fetch });
    expect({ kind: qualifier.kind, version: qualifier.version }).toEqual({
      kind: 'openai-compatible',
      version: '1',
    });
    const results = await qualifier.qualify(request());

    expect(results).toEqual([
      {
        operation: 'generate',
        operationKind: 'generate-text',
        status: 'qualified',
        reasonCode: 'qualified',
      },
      {
        operation: 'embed',
        operationKind: 'embedding',
        status: 'qualified',
        reasonCode: 'qualified',
      },
    ]);
    expect(paths).toEqual([
      '/v1/models',
      '/v1/chat/completions',
      '/v1/embeddings',
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does no operation I/O for unqualified generation configuration', async () => {
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      paths.push(path);
      return path.endsWith('/models')
        ? Response.json({
            data: [{ id: 'text-model' }, { id: 'embedding-model' }],
          })
        : embeddingResponse();
    });
    const sealed = bindings();
    const qualifier = new OpenAICompatibleRuntimeOperationQualifier({ fetch });
    const mixed = await qualifier.qualify(
      request(sealed, { maxGenerationOutputTokensPerCall: 499 }),
    );

    expect(mixed).toEqual([
      expect.objectContaining({
        operation: 'generate',
        reasonCode: 'operation_configuration_unqualified',
      }),
      expect.objectContaining({
        operation: 'embed',
        status: 'qualified',
      }),
    ]);
    expect(paths).toEqual(['/v1/models', '/v1/embeddings']);

    const { digest: _digest, ...content } = sealed;
    const changed = structuredClone(content);
    const generation = changed.targets[0]?.operations.find(
      (operation) => operation.kind === 'generate-text',
    );
    if (generation === undefined || generation.kind !== 'generate-text') {
      throw new Error('expected_generation_binding');
    }
    delete generation.maxOutputTokens;
    const withoutMax = sealRuntimeBindings(changed);
    const generationOnly = withoutMax.targets[0]!.operations.find(
      (operation) => operation.kind === 'generate-text',
    )!;
    fetch.mockClear();
    paths.length = 0;

    const missing = await qualifier.qualify(
      request(withoutMax, { operations: [generationOnly] }),
    );
    expect(missing[0]?.reasonCode).toBe('operation_configuration_unqualified');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('omits optional generation knobs when the binding omits them', async () => {
    const original = bindings();
    const { digest: _digest, ...content } = original;
    const changed = structuredClone(content);
    const generation = changed.targets[0]?.operations.find(
      (operation) => operation.kind === 'generate-text',
    );
    if (generation === undefined || generation.kind !== 'generate-text') {
      throw new Error('expected_generation_binding');
    }
    delete generation.systemPrompt;
    delete generation.temperature;
    const sealed = sealRuntimeBindings(changed);
    const selected = sealed.targets[0]!.operations.find(
      (operation) => operation.kind === 'generate-text',
    )!;
    let operationBody: Record<string, unknown> | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith('/models')) {
        return Response.json({ data: [{ id: 'text-model' }] });
      }
      operationBody = await requestBody(input, init);
      return textResponse();
    });

    const result = await new OpenAICompatibleRuntimeOperationQualifier({
      fetch,
    }).qualify(request(sealed, { operations: [selected] }));

    expect(result[0]?.status).toBe('qualified');
    expect(operationBody).toMatchObject({
      max_tokens: 500,
      messages: [{ role: 'user', content: 'OK' }],
    });
    expect(operationBody).not.toHaveProperty('temperature');
  });

  it('still exercises an operation once when its discovery model is absent', async () => {
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      paths.push(path);
      return path.endsWith('/models')
        ? Response.json({ data: [] })
        : textResponse();
    });
    const sealed = bindings();
    const result = await new OpenAICompatibleRuntimeOperationQualifier({
      fetch,
    }).qualify(
      request(sealed, { operations: [sealed.targets[0]!.operations[0]!] }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        operation: 'generate',
        status: 'rejected',
        reasonCode: 'model_unavailable',
      }),
    ]);
    expect(paths).toEqual(['/v1/models', '/v1/chat/completions']);
  });

  it('fails without I/O when a referenced credential is absent or malformed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const sealed = bindings();
    const qualifier = new OpenAICompatibleRuntimeOperationQualifier({ fetch });
    const operation = sealed.targets[0]!.operations[0]!;

    for (const credential of ['', 'bad\nheader']) {
      const result = await qualifier.qualify(
        request(sealed, { operations: [operation], credential }),
      );
      expect(result[0]?.reasonCode).toBe('credential_unavailable');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.invalid/v1/models' },
        }),
      'upstream_redirect',
    ],
    [
      'malformed JSON shape',
      () => Response.json({ models: [{ secret: RAW_ERROR }] }),
      'response_invalid',
    ],
    [
      'oversized body',
      () => Response.json({ data: [{ id: RAW_ERROR.repeat(200) }] }),
      'response_too_large',
    ],
  ] as const)(
    'collapses %s discovery responses while keeping the operation budget exact',
    async (_label, discoveryResponse, reasonCode) => {
      const paths: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const path = new URL(requestUrl(input)).pathname;
        paths.push(path);
        return path.endsWith('/models') ? discoveryResponse() : textResponse();
      });
      const sealed = bindings();
      const result = await new OpenAICompatibleRuntimeOperationQualifier({
        fetch,
      }).qualify(
        request(sealed, {
          operations: [sealed.targets[0]!.operations[0]!],
          maxResponseBytes: 1_024,
        }),
      );
      expect(result[0]?.reasonCode).toBe(reasonCode);
      expect(JSON.stringify(result)).not.toContain(RAW_ERROR);
      expect(JSON.stringify(result)).not.toContain('attacker.invalid');
      expect(paths).toEqual(['/v1/models', '/v1/chat/completions']);
    },
  );

  it('normalizes raw provider failures and never retries them', async () => {
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      paths.push(path);
      if (path.endsWith('/models')) {
        return Response.json({ data: [{ id: 'text-model' }] });
      }
      throw new Error(`${RAW_ERROR} at https://runtime.invalid/v1`);
    });
    const sealed = bindings();
    const result = await new OpenAICompatibleRuntimeOperationQualifier({
      fetch,
    }).qualify(
      request(sealed, { operations: [sealed.targets[0]!.operations[0]!] }),
    );
    expect(result[0]?.reasonCode).toBe('network_failure');
    expect(JSON.stringify(result)).not.toContain(RAW_ERROR);
    expect(paths).toEqual(['/v1/models', '/v1/chat/completions']);
  });

  it('enforces per-request timeouts and embedding output contracts', async () => {
    const sealed = bindings();
    const generation = sealed.targets[0]!.operations[0]!;
    const timeoutFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith('/models')) {
        return Response.json({ data: [{ id: 'text-model' }] });
      }
      return new Promise<Response>(() => {
        // The bounded fetch deadline must settle this request.
      });
    });
    const timedOut = await new OpenAICompatibleRuntimeOperationQualifier({
      fetch: timeoutFetch,
    }).qualify(
      request(sealed, {
        operations: [generation],
        requestTimeoutMs: 100,
      }),
    );
    expect(timedOut[0]?.reasonCode).toBe('request_timeout');
    expect(timeoutFetch).toHaveBeenCalledTimes(2);

    const embedding = sealed.targets[0]!.operations[1]!;
    const invalidVectorFetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      new URL(requestUrl(input)).pathname.endsWith('/models')
        ? Response.json({ data: [{ id: 'embedding-model' }] })
        : embeddingResponse([0.1, 0.2]),
    );
    const invalidVector = await new OpenAICompatibleRuntimeOperationQualifier({
      fetch: invalidVectorFetch,
    }).qualify(request(sealed, { operations: [embedding] }));
    expect(invalidVector[0]?.reasonCode).toBe('operation_output_invalid');
  });

  it('rejects a forged operation binding before I/O', async () => {
    const sealed = bindings();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const forged = {
      ...sealed.targets[0]!.operations[0]!,
      model: 'forged-model',
    };
    await expect(
      new OpenAICompatibleRuntimeOperationQualifier({ fetch }).qualify(
        request(sealed, { operations: [forged] }),
      ),
    ).rejects.toBeInstanceOf(OpenAICompatibleQualificationError);
    await expect(
      new OpenAICompatibleRuntimeOperationQualifier({ fetch }).qualify({
        ...request(sealed),
        operations: [null] as never,
      }),
    ).rejects.toBeInstanceOf(OpenAICompatibleQualificationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

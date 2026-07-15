import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleStageAdapter } from '../../src/adapters/openai-compatible-stage-adapter.js';
import {
  sealRuntimeBindings,
  type RuntimeBindings,
} from '../../src/domain/runtime-bindings.js';
import { STAGEFABRIC_API_VERSION } from '../../src/domain/schema.js';
import { StageAdapterError } from '../../src/ports/stage-adapter.js';

const API_KEY = 'sk-adapter-sentinel';

function bindings(
  policy: { requestTimeoutMs?: number; maxResponseBytes?: number } = {},
): RuntimeBindings {
  return sealRuntimeBindings({
    apiVersion: STAGEFABRIC_API_VERSION,
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: policy.requestTimeoutMs ?? 1_000,
      maxResponseBytes: policy.maxResponseBytes ?? 16_384,
      snapshotTtlSeconds: 60,
    },
    targets: [
      {
        targetId: 'cloud-ai',
        provider: {
          kind: 'openai-compatible',
          name: 'test-provider',
          baseUrl: 'https://provider.invalid/v1',
          apiKeyEnv: 'STAGEFABRIC_TEST_PROVIDER_API_KEY',
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'summarize',
            capabilities: ['text-generation'],
            model: 'text-model',
            input: 'prompt',
            output: 'answer',
            systemPrompt: 'Answer concisely.',
            temperature: 0.25,
            maxOutputTokens: 42,
          },
          {
            kind: 'embedding',
            operation: 'vectorize',
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
  overrides: Partial<{
    operation: string;
    targetId: string;
    inputs: Readonly<Record<string, unknown>>;
    expectedOutputs: readonly string[];
  }> = {},
) {
  return {
    stageId: 'stage-a',
    operation: overrides.operation ?? 'summarize',
    targetId: overrides.targetId ?? 'cloud-ai',
    zone: 'cloud',
    inputs: overrides.inputs ?? { prompt: 'Condense this.' },
    expectedOutputs: overrides.expectedOutputs ?? ['answer'],
  };
}

function mockFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return vi.fn(implementation) as typeof globalThis.fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    throw new Error('expected_string_body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function adapter(fetch: typeof globalThis.fetch) {
  return new OpenAICompatibleStageAdapter({
    bindings: bindings(),
    environment: { STAGEFABRIC_TEST_PROVIDER_API_KEY: API_KEY },
    fetch,
  });
}

async function capturedError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.catch((error: unknown) => error);
}

describe('OpenAICompatibleStageAdapter', () => {
  it('maps a sealed generate-text operation to a bounded non-streaming request', async () => {
    const upstream = mockFetch(async (input, init) => {
      expect(requestUrl(input)).toBe(
        'https://provider.invalid/v1/chat/completions',
      );
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${API_KEY}`,
      );
      expect(init?.redirect).toBe('manual');

      const body = jsonBody(init);
      expect(body).toMatchObject({
        model: 'text-model',
        max_tokens: 42,
        temperature: 0.25,
        messages: [
          { role: 'system', content: 'Answer concisely.' },
          { role: 'user', content: 'Condense this.' },
        ],
      });
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('stream');

      return Response.json({
        choices: [
          {
            message: { role: 'assistant', content: 'Short answer.' },
            finish_reason: 'stop',
          },
        ],
      });
    });

    await expect(adapter(upstream).execute(request())).resolves.toEqual({
      outputs: { answer: 'Short answer.' },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('maps an embedding operation to a finite numeric vector', async () => {
    const upstream = mockFetch(async (input, init) => {
      expect(requestUrl(input)).toBe('https://provider.invalid/v1/embeddings');
      expect(jsonBody(init)).toMatchObject({
        model: 'embedding-model',
        input: ['Vectorize this.'],
        encoding_format: 'float',
      });
      return Response.json({
        data: [{ embedding: [0.125, -0.5, 1] }],
        usage: { prompt_tokens: 3 },
      });
    });

    await expect(
      adapter(upstream).execute(
        request({
          operation: 'vectorize',
          inputs: { text: 'Vectorize this.' },
          expectedOutputs: ['vector'],
        }),
      ),
    ).resolves.toEqual({ outputs: { vector: [0.125, -0.5, 1] } });
  });

  it.each([
    [
      'empty text',
      { message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
    ],
    [
      'whitespace-only text',
      {
        message: { role: 'assistant', content: ' \n\t ' },
        finish_reason: 'stop',
      },
    ],
    [
      'reasoning-only output',
      {
        message: {
          role: 'assistant',
          content: null,
          reasoning: `hidden-${API_KEY}`,
        },
        finish_reason: 'stop',
      },
    ],
    [
      'refusal-only output',
      {
        message: {
          role: 'assistant',
          content: null,
          refusal: `refusal-${API_KEY}`,
        },
        finish_reason: 'stop',
      },
    ],
  ] as const)('rejects %s as a non-text result', async (_label, choice) => {
    const upstream = mockFetch(async () =>
      Response.json({ choices: [choice] }),
    );

    const error = await capturedError(adapter(upstream).execute(request()));

    expect(error).toMatchObject({
      code: 'adapter_failure',
      message: 'adapter_failure',
      outputEmitted: false,
    });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([2, 4])(
    'rejects an embedding with %i dimensions when exactly three are bound',
    async (dimensions) => {
      const upstream = mockFetch(async () =>
        Response.json({
          data: [
            {
              embedding: Array.from(
                { length: dimensions },
                (_value, index) => index / 10,
              ),
            },
          ],
        }),
      );

      const error = await capturedError(
        adapter(upstream).execute(
          request({
            operation: 'vectorize',
            inputs: { text: 'Vectorize this.' },
            expectedOutputs: ['vector'],
          }),
        ),
      );

      expect(error).toMatchObject({
        code: 'adapter_failure',
        message: 'adapter_failure',
        outputEmitted: false,
      });
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a non-finite embedding response', async () => {
    const upstream = mockFetch(
      async () =>
        new Response('{"data":[{"embedding":[0,1e400,2]}]}', {
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      adapter(upstream).execute(
        request({
          operation: 'vectorize',
          inputs: { text: 'Vectorize this.' },
          expectedOutputs: ['vector'],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'adapter_failure',
      message: 'adapter_failure',
      outputEmitted: false,
    });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown target', request({ targetId: 'other' })],
    ['unknown operation', request({ operation: 'other' })],
    ['wrong input name', request({ inputs: { other: 'text' } })],
    ['extra input', request({ inputs: { prompt: 'text', extra: 'no' } })],
    ['non-string input', request({ inputs: { prompt: 42 } })],
    ['wrong output', request({ expectedOutputs: ['other'] })],
    ['extra output', request({ expectedOutputs: ['answer', 'other'] })],
  ])('fails closed before I/O for %s', async (_label, adapterRequest) => {
    const upstream = mockFetch(async () => Response.json({}));

    await expect(
      adapter(upstream).execute(adapterRequest),
    ).rejects.toMatchObject({
      code: 'adapter_failure',
      message: 'adapter_failure',
      outputEmitted: false,
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fails closed when the symbolic API key is absent', async () => {
    const upstream = mockFetch(async () => Response.json({}));
    const stageAdapter = new OpenAICompatibleStageAdapter({
      bindings: bindings(),
      environment: {},
      fetch: upstream,
    });

    await expect(stageAdapter.execute(request())).rejects.toMatchObject({
      code: 'adapter_failure',
      message: 'adapter_failure',
      outputEmitted: false,
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'upstream_rejected'],
    [502, 'upstream_unavailable'],
    [503, 'upstream_unavailable'],
    [504, 'upstream_unavailable'],
  ] as const)(
    'preserves retryable pre-output status %i',
    async (statusCode, code) => {
      const upstream = mockFetch(async () =>
        Response.json(
          { error: { message: `${API_KEY}-response`, type: 'sentinel' } },
          { status: statusCode },
        ),
      );

      const error = await capturedError(adapter(upstream).execute(request()));

      expect(error).toBeInstanceOf(StageAdapterError);
      expect(error).toMatchObject({
        code,
        message: code,
        statusCode,
        outputEmitted: false,
      });
      expect(String(error)).not.toContain(API_KEY);
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it('normalizes timeout failures without an ambiguous retryable status', async () => {
    const upstream = mockFetch(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException(API_KEY, 'AbortError')),
            { once: true },
          );
        }),
    );
    const stageAdapter = new OpenAICompatibleStageAdapter({
      bindings: bindings({ requestTimeoutMs: 100 }),
      environment: { STAGEFABRIC_TEST_PROVIDER_API_KEY: API_KEY },
      fetch: upstream,
    });

    const error = await capturedError(stageAdapter.execute(request()));

    expect(error).toMatchObject({
      code: 'timeout',
      message: 'timeout',
      outputEmitted: false,
    });
    expect(error).not.toHaveProperty('statusCode', 429);
    expect(String(error)).not.toContain(API_KEY);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'redirect',
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://attacker.invalid/${API_KEY}` },
        }),
    ],
    [
      'oversize response',
      async () =>
        new Response(API_KEY.padEnd(1_025, 'x'), {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    ['malformed response', async () => Response.json({ sentinel: API_KEY })],
    [
      'unsolicited tool call',
      async () =>
        Response.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-sentinel',
                    function: {
                      name: 'forbidden_side_effect',
                      arguments: JSON.stringify({ sentinel: API_KEY }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
    ],
  ] as const)('redacts %s failures', async (_label, response) => {
    const upstream = mockFetch(response);
    const stageAdapter = new OpenAICompatibleStageAdapter({
      bindings: bindings({ maxResponseBytes: 1_024 }),
      environment: { STAGEFABRIC_TEST_PROVIDER_API_KEY: API_KEY },
      fetch: upstream,
    });

    const error = await capturedError(stageAdapter.execute(request()));

    expect(error).toBeInstanceOf(StageAdapterError);
    expect(error).toMatchObject({
      code: 'adapter_failure',
      message: 'adapter_failure',
      outputEmitted: false,
    });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain('provider.invalid');
    expect(String(error)).not.toContain('attacker.invalid');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered bindings digest without exposing configuration', () => {
    const sealed = bindings();
    const tampered = {
      ...sealed,
      policy: { ...sealed.policy, requestTimeoutMs: 2_000 },
    };

    expect(
      () =>
        new OpenAICompatibleStageAdapter({
          bindings: tampered,
          environment: { STAGEFABRIC_TEST_PROVIDER_API_KEY: API_KEY },
          fetch: mockFetch(async () => Response.json({})),
        }),
    ).toThrowError(
      expect.objectContaining({
        code: 'adapter_failure',
        message: 'adapter_failure',
      }),
    );
  });
});

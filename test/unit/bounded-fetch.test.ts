import { describe, expect, it, vi } from 'vitest';
import {
  BoundedFetchError,
  createBoundedFetch,
} from '../../src/adapters/bounded-fetch.js';

function mockFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return vi.fn(implementation) as typeof globalThis.fetch;
}

describe('createBoundedFetch', () => {
  it('allows only the configured origin and path prefix and forces manual redirects', async () => {
    const upstream = mockFetch(async (_input, init) => {
      expect(init?.redirect).toBe('manual');
      return new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json' },
      });
    });
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1/',
      allowedPathnames: ['/v1/chat/completions'],
      timeoutMs: 100,
      maxResponseBytes: 128,
      fetch: upstream,
    });

    const response = await bounded(
      'https://provider.invalid/v1/chat/completions',
      { redirect: 'follow' },
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    await expect(
      bounded('https://provider.invalid/v10/chat/completions'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(
      bounded('https://provider.invalid/v1/embeddings'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(
      bounded('https://other.invalid/v1/chat/completions'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(
      bounded('https://provider.invalid/v1/chat/completions?leak=true'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(
      bounded('https://provider.invalid/v1/chat/completions#fragment'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(
      bounded('https://provider.invalid/v1/a%2fb'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(
      bounded('https://provider.invalid/v1\\chat/completions'),
    ).rejects.toMatchObject({ code: 'request_rejected' });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('requires HTTPS except for an explicit loopback HTTP endpoint', async () => {
    const upstream = mockFetch(async () => new Response('ok'));

    expect(() =>
      createBoundedFetch({
        baseUrl: 'http://provider.invalid/v1',
        allowedPathnames: ['/v1/models'],
        timeoutMs: 100,
        maxResponseBytes: 128,
        fetch: upstream,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_configuration' }));

    const loopback = createBoundedFetch({
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowedPathnames: ['/v1/models'],
      timeoutMs: 100,
      maxResponseBytes: 128,
      fetch: upstream,
    });
    await expect(
      loopback('http://127.0.0.1:11434/v1/models'),
    ).resolves.toBeInstanceOf(Response);
  });

  it('snapshots native URL inputs and rejects arbitrary coercible objects', async () => {
    const seen: string[] = [];
    const upstream = mockFetch(async (input) => {
      seen.push(input instanceof Request ? input.url : input.toString());
      return new Response('ok');
    });
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/models'],
      timeoutMs: 100,
      maxResponseBytes: 128,
      fetch: upstream,
    });
    class StatefulUrl extends URL {
      override toString(): string {
        return 'https://attacker.invalid/steal';
      }
    }

    await expect(
      bounded(new StatefulUrl('https://provider.invalid/v1/models')),
    ).resolves.toBeInstanceOf(Response);

    let coercions = 0;
    const stateful = {
      toString: () => {
        coercions += 1;
        return coercions === 1
          ? 'https://provider.invalid/v1/models'
          : 'https://attacker.invalid/steal';
      },
    } as unknown as RequestInfo;
    await expect(bounded(stateful)).rejects.toMatchObject({
      code: 'request_rejected',
    });

    expect(coercions).toBe(0);
    expect(seen).toEqual(['https://provider.invalid/v1/models']);
  });

  it('rejects redirects without following them', async () => {
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/chat/completions'],
      timeoutMs: 100,
      maxResponseBytes: 128,
      fetch: mockFetch(
        async () =>
          new Response(null, {
            status: 307,
            headers: { location: 'https://attacker.invalid/sentinel' },
          }),
      ),
    });

    await expect(
      bounded('https://provider.invalid/v1/chat/completions'),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'upstream_redirect',
        message: 'upstream_redirect',
        statusCode: 307,
      }),
    );
  });

  it('enforces both declared and actual response-size limits', async () => {
    const declared = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/embeddings'],
      timeoutMs: 100,
      maxResponseBytes: 4,
      fetch: mockFetch(
        async () => new Response('x', { headers: { 'content-length': '5' } }),
      ),
    });
    const actual = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/embeddings'],
      timeoutMs: 100,
      maxResponseBytes: 4,
      fetch: mockFetch(async () => new Response('12345')),
    });

    await expect(
      declared('https://provider.invalid/v1/embeddings'),
    ).rejects.toMatchObject({ code: 'upstream_response_too_large' });
    await expect(
      actual('https://provider.invalid/v1/embeddings'),
    ).rejects.toMatchObject({ code: 'upstream_response_too_large' });
  });

  it('bounds the full response lifetime with a timeout', async () => {
    const upstream = mockFetch(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('provider secret', 'AbortError')),
            { once: true },
          );
        }),
    );
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/chat/completions'],
      timeoutMs: 5,
      maxResponseBytes: 128,
      fetch: upstream,
    });

    await expect(
      bounded('https://provider.invalid/v1/chat/completions'),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'request_timeout',
        message: 'request_timeout',
      }),
    );
  });

  it('times out while consuming a response body that never completes', async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue or close.
      },
    });
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/models'],
      timeoutMs: 5,
      maxResponseBytes: 128,
      fetch: mockFetch(async () => new Response(body)),
    });

    await expect(
      bounded('https://provider.invalid/v1/models'),
    ).rejects.toMatchObject({ code: 'request_timeout' });
  });

  it('preserves caller cancellation as a content-free typed error', async () => {
    const controller = new AbortController();
    controller.abort('sentinel-secret');
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/embeddings'],
      timeoutMs: 100,
      maxResponseBytes: 128,
      fetch: mockFetch(async () => new Response()),
    });

    const error = await bounded('https://provider.invalid/v1/embeddings', {
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BoundedFetchError);
    expect(error).toMatchObject({
      code: 'request_aborted',
      message: 'request_aborted',
    });
    expect(String(error)).not.toContain('sentinel-secret');
  });

  it('does not expose an upstream cause, URL, or body in failures', async () => {
    const secret = 'sk-sentinel-secret';
    const bounded = createBoundedFetch({
      baseUrl: 'https://provider.invalid/v1',
      allowedPathnames: ['/v1/chat/completions'],
      timeoutMs: 100,
      maxResponseBytes: 128,
      fetch: mockFetch(async () => {
        throw new Error(`${secret} https://provider.invalid/private`);
      }),
    });

    const error = await bounded(
      'https://provider.invalid/v1/chat/completions',
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'network_failure',
      message: 'network_failure',
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain('provider.invalid');
  });
});

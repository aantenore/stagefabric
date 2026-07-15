import { describe, expect, it, vi } from 'vitest';

import {
  CapabilityProbeError,
  probeOpenAICompatibleCapabilities,
  probeRuntimeBindings,
} from '../../src/adapters/openai-compatible-capability-probe.js';
import {
  sealRuntimeBindings,
  type RuntimeBindings,
} from '../../src/domain/runtime-bindings.js';
import { verifyCapabilitySnapshotDigest } from '../../src/domain/snapshot.js';

function bindings(options: { authenticated?: boolean } = {}): RuntimeBindings {
  return sealRuntimeBindings({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 5_000,
      maxResponseBytes: 1_024,
      snapshotTtlSeconds: 90,
    },
    targets: [
      {
        targetId: 'edge-a',
        provider: {
          kind: 'openai-compatible',
          name: 'edge-vllm',
          baseUrl: 'http://localhost:8000/v1',
          ...(options.authenticated
            ? { apiKeyEnv: 'STAGEFABRIC_EDGE_API_KEY' }
            : {}),
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'summarize',
            capabilities: ['summarization', 'text-generation'],
            model: 'acme/generate',
            input: 'prompt',
            output: 'summary',
          },
          {
            kind: 'embedding',
            operation: 'embed',
            capabilities: ['embedding'],
            model: 'acme/embed',
            input: 'text',
            output: 'vector',
            expectedDimensions: 3,
          },
        ],
      },
    ],
  });
}

function fetchResponse(body: unknown, init: ResponseInit = {}) {
  return vi.fn<typeof globalThis.fetch>(async () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
    ),
  );
}

describe('OpenAI-compatible capability probe', () => {
  it('advertises capabilities only for models observed upstream', async () => {
    const sealed = bindings({ authenticated: true });
    const fetch = fetchResponse({ data: [{ id: 'acme/generate' }] });
    const resolveBearerToken = vi.fn(() => 'private-token');

    const snapshot = await probeRuntimeBindings({
      bindings: sealed,
      observedAt: '2026-07-15T12:30:00+02:00',
      fetch,
      resolveBearerToken,
    });

    expect(snapshot).toMatchObject({
      bindingDigest: sealed.digest,
      observedAt: '2026-07-15T10:30:00.000Z',
      expiresAt: '2026-07-15T10:31:30.000Z',
      targets: [
        {
          targetId: 'edge-a',
          healthy: true,
          capabilities: [
            'stagefabric.operation/summarize',
            'summarization',
            'text-generation',
          ],
        },
      ],
    });
    expect(verifyCapabilitySnapshotDigest(snapshot)).toBe(true);
    const rebound = {
      ...snapshot,
      bindingDigest: `sha256:${'0'.repeat(64)}` as const,
    };
    expect(verifyCapabilitySnapshotDigest(rebound)).toBe(false);
    expect(resolveBearerToken).toHaveBeenCalledWith({
      targetId: 'edge-a',
      providerName: 'edge-vllm',
      apiKeyEnv: 'STAGEFABRIC_EDGE_API_KEY',
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('http://localhost:8000/v1/models');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer private-token',
    );
  });

  it('keeps a valid but model-missing target healthy with no capabilities', async () => {
    const snapshot = await probeRuntimeBindings({
      bindings: bindings(),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch: fetchResponse({ data: [{ id: 'another/model' }] }),
    });
    expect(snapshot.targets[0]).toEqual({
      targetId: 'edge-a',
      healthy: true,
      capabilities: [],
    });
  });

  it('fails closed for a malformed JSON shape', async () => {
    const snapshot = await probeRuntimeBindings({
      bindings: bindings(),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch: fetchResponse({ models: [] }),
    });
    expect(snapshot.targets[0]).toEqual({
      targetId: 'edge-a',
      healthy: false,
      capabilities: [],
    });
  });

  it('ignores provider metadata and trusts only bounded model ids', async () => {
    const snapshot = await probeRuntimeBindings({
      bindings: bindings(),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch: fetchResponse({
        object: 'list',
        provider_extension: { ignored: true },
        data: [
          {
            id: 'acme/generate',
            object: 'model',
            created: 1_721_177_280,
            owned_by: 'upstream',
            root: 'acme/generate',
            max_model_len: 32_768,
          },
        ],
      }),
    });

    expect(snapshot.targets[0]).toEqual({
      targetId: 'edge-a',
      healthy: true,
      capabilities: [
        'stagefabric.operation/summarize',
        'summarization',
        'text-generation',
      ],
    });
  });

  it('fails closed without resolving a referenced bearer token', async () => {
    const fetch = fetchResponse({ data: [{ id: 'acme/generate' }] });
    const snapshot = await probeRuntimeBindings({
      bindings: bindings({ authenticated: true }),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch,
      resolveBearerToken: () => undefined,
    });
    expect(snapshot.targets[0]?.healthy).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('collapses network details and response payloads into an opaque state', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error(
        'secret payload from https://private.example/v1?token=do-not-leak',
      );
    });
    const snapshot = await probeRuntimeBindings({
      bindings: bindings(),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch,
    });
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.targets[0]).toEqual({
      targetId: 'edge-a',
      healthy: false,
      capabilities: [],
    });
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('do-not-leak');
  });

  it('fails closed on oversized bodies and redirects', async () => {
    const oversized = fetchResponse({ data: [{ id: 'x'.repeat(2_000) }] });
    const oversizedSnapshot = await probeRuntimeBindings({
      bindings: bindings(),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch: oversized,
    });
    expect(oversizedSnapshot.targets[0]?.healthy).toBe(false);

    const redirect = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/models' },
        }),
      ),
    );
    const redirectSnapshot = await probeRuntimeBindings({
      bindings: bindings(),
      observedAt: '2026-07-15T10:30:00.000Z',
      fetch: redirect,
    });
    expect(redirectSnapshot.targets[0]?.healthy).toBe(false);
  });

  it('rejects tampered bindings before I/O', async () => {
    const tampered = bindings();
    tampered.policy.snapshotTtlSeconds = 91;
    const fetch = fetchResponse({ data: [] });
    await expect(
      probeRuntimeBindings({
        bindings: tampered,
        observedAt: '2026-07-15T10:30:00.000Z',
        fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityProbeError>>({
        code: 'binding_digest_mismatch',
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unsafe direct-probe target before I/O', async () => {
    const fetch = fetchResponse({ data: [] });
    const target = structuredClone(bindings().targets[0]!);
    target.provider.baseUrl = 'http://169.254.169.254/latest';
    await expect(
      probeOpenAICompatibleCapabilities({
        target,
        policy: { requestTimeoutMs: 5_000, maxResponseBytes: 1_024 },
        fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityProbeError>>({
        code: 'bindings_invalid',
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

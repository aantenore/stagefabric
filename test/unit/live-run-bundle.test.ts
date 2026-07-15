import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  MAX_LIVE_RUN_BUNDLE_BYTES,
  LiveRunBundleError,
  parseLiveRunBundle,
  parseRuntimeBindingsFile,
} from '../../src/adapters/live-run-bundle.js';
import { sealRuntimeBindings } from '../../src/domain/runtime-bindings.js';

function rawBundle() {
  return {
    fabric: {
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'Fabric',
      zones: [{ id: 'local', trustLevel: 1, residencies: ['EU'] }],
      classifications: [{ id: 'public', rank: 0 }],
      targets: [
        {
          id: 'ollama',
          zone: 'local',
          adapter: { kind: 'openai-compatible' },
          capabilities: ['text-generation'],
          expectedP95Ms: 10,
          costMicros: 0,
        },
      ],
    },
    graph: {
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'StageGraph',
      metadata: { name: 'live' },
      inputs: [
        {
          name: 'prompt',
          type: 'text/plain',
          classification: 'public',
        },
      ],
      stages: [
        {
          id: 'answer',
          operation: 'generate',
          inputs: { prompt: { ref: 'input.prompt', type: 'text/plain' } },
          outputs: [
            { name: 'text', type: 'text/plain', classification: 'public' },
          ],
          requirements: { capabilities: ['text-generation'] },
        },
      ],
    },
    inputs: { prompt: 'Hello.' },
  };
}

function bindingContent() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeBindings',
    policy: {
      requestTimeoutMs: 5_000,
      maxResponseBytes: 65_536,
      snapshotTtlSeconds: 60,
    },
    targets: [
      {
        targetId: 'ollama',
        provider: {
          kind: 'openai-compatible',
          name: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1/',
        },
        operations: [
          {
            kind: 'generate-text',
            operation: 'generate',
            capabilities: ['text-generation'],
            model: 'qwen3:4b',
            input: 'prompt',
            output: 'text',
          },
        ],
      },
    ],
  };
}

describe('live-run bundle', () => {
  it('keeps the checked-in Ollama example parseable', () => {
    const parsed = parseLiveRunBundle(
      readFileSync(resolve('examples/live-stagefabric.yaml'), 'utf8'),
    );
    expect(parsed.graph).toMatchObject({
      metadata: { name: 'local-live-ai' },
      stages: [{ operation: 'embed' }, { operation: 'generate' }],
    });
    expect(
      parseRuntimeBindingsFile(
        readFileSync(resolve('examples/runtime-bindings.ollama.yaml'), 'utf8'),
      ),
    ).toMatchObject({
      kind: 'RuntimeBindings',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('strictly separates the graph bundle from operator runtime bindings', () => {
    const parsed = parseLiveRunBundle(stringify(rawBundle()));
    expect(parsed).not.toHaveProperty('bindings');

    const sealed = parseRuntimeBindingsFile(stringify(bindingContent()));

    expect(sealed).toMatchObject({
      kind: 'RuntimeBindings',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      targets: [
        {
          provider: { baseUrl: 'http://127.0.0.1:11434/v1' },
        },
      ],
    });
  });

  it('accepts an intact sealed binding and rejects a tampered digest', () => {
    const sealed = sealRuntimeBindings(bindingContent());
    expect(() => parseRuntimeBindingsFile(stringify(sealed))).not.toThrow();

    const tampered = {
      ...sealed,
      policy: { ...sealed.policy, snapshotTtlSeconds: 61 },
    };
    expect(() => parseRuntimeBindingsFile(stringify(tampered))).toThrowError(
      expect.objectContaining<Partial<LiveRunBundleError>>({
        code: 'runtime_binding_digest_mismatch',
      }),
    );
  });

  it('rejects aliases, unknown fields, and oversized input', () => {
    expect(() =>
      parseLiveRunBundle('fabric: &fabric {}\ngraph: *fabric\n'),
    ).toThrowError(
      expect.objectContaining<Partial<LiveRunBundleError>>({
        code: 'live_bundle_yaml_invalid',
      }),
    );

    const withExtra = { ...rawBundle(), extra: true };
    expect(() => parseLiveRunBundle(stringify(withExtra))).toThrowError(
      expect.objectContaining<Partial<LiveRunBundleError>>({
        code: 'live_bundle_invalid',
      }),
    );

    expect(() =>
      parseLiveRunBundle('x'.repeat(MAX_LIVE_RUN_BUNDLE_BYTES + 1)),
    ).toThrowError(
      expect.objectContaining<Partial<LiveRunBundleError>>({
        code: 'live_bundle_too_large',
      }),
    );
  });

  it('never exposes user-controlled schema text in structured issues', () => {
    const sentinel = 'sk-live-secret-value';
    const error = (() => {
      try {
        parseLiveRunBundle(stringify({ ...rawBundle(), [sentinel]: true }));
      } catch (caught) {
        return caught;
      }
      throw new Error('expected parse failure');
    })();

    expect(error).toBeInstanceOf(LiveRunBundleError);
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });
});

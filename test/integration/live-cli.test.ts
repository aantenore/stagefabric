import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { runCli } from '../../src/entrypoints/cli.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

describe('live-run CLI', () => {
  it('probes and executes a real loopback OpenAI-compatible boundary', async () => {
    const seenPaths: string[] = [];
    const server = createServer((request, response) => {
      seenPaths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'test-live-model' }] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'CLI live answer.' },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    cleanup.push(
      async () =>
        await new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('loopback_server_address_missing');
    }

    const directory = await mkdtemp(join(tmpdir(), 'stagefabric-live-'));
    cleanup.push(async () => await rm(directory, { recursive: true }));
    const bundlePath = join(directory, 'live.yaml');
    const bindingsPath = join(directory, 'runtime-bindings.yaml');
    const secretInput = 'input-sentinel-that-must-not-enter-trace';
    await writeFile(
      bundlePath,
      stringify({
        fabric: {
          apiVersion: 'stagefabric.dev/v1alpha1',
          kind: 'Fabric',
          zones: [{ id: 'local', trustLevel: 1, residencies: ['EU'] }],
          classifications: [{ id: 'public', rank: 0 }],
          targets: [
            {
              id: 'loopback-model',
              zone: 'local',
              adapter: { kind: 'openai-compatible' },
              capabilities: ['text-generation'],
              expectedP95Ms: 1,
              costMicros: 0,
            },
          ],
        },
        graph: {
          apiVersion: 'stagefabric.dev/v1alpha1',
          kind: 'StageGraph',
          metadata: { name: 'cli-live' },
          inputs: [
            {
              name: 'prompt',
              type: 'text/plain',
              classification: 'public',
              origin: { zone: 'local' },
            },
          ],
          stages: [
            {
              id: 'answer',
              operation: 'generate',
              inputs: {
                prompt: { ref: 'input.prompt', type: 'text/plain' },
              },
              outputs: [
                {
                  name: 'text',
                  type: 'text/plain',
                  classification: 'public',
                },
              ],
              requirements: { capabilities: ['text-generation'] },
            },
          ],
        },
        inputs: { prompt: secretInput },
      }),
      'utf8',
    );
    await writeFile(
      bindingsPath,
      stringify({
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'RuntimeBindings',
        policy: {
          requestTimeoutMs: 5_000,
          maxResponseBytes: 65_536,
          snapshotTtlSeconds: 60,
        },
        targets: [
          {
            targetId: 'loopback-model',
            provider: {
              kind: 'openai-compatible',
              name: 'loopback',
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
            },
            operations: [
              {
                kind: 'generate-text',
                operation: 'generate',
                capabilities: ['text-generation'],
                model: 'test-live-model',
                input: 'prompt',
                output: 'text',
              },
            ],
          },
        ],
      }),
      'utf8',
    );

    let output = '';
    let errors = '';
    const exitCode = await runCli(
      ['node', 'stagefabric', 'run', bundlePath, '--bindings', bindingsPath],
      {
        writeOut: (value) => {
          output += value;
        },
        writeErr: (value) => {
          errors += value;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toBe('');
    expect(JSON.parse(output)).toMatchObject({
      graphName: 'cli-live',
      placements: [{ stageId: 'answer', targetId: 'loopback-model' }],
      outputs: { 'answer.text': 'CLI live answer.' },
      trace: [{ reasonCode: 'completed' }],
    });
    expect(output).not.toContain(secretInput);
    expect(seenPaths).toEqual(['/v1/models', '/v1/chat/completions']);
  });
});

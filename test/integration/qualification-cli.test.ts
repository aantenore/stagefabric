import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { runCli } from '../../src/entrypoints/cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('qualification CLI', () => {
  it('emits a content-free report and fails the gate on a rejected operation', async () => {
    let rejectOperation = false;
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'cli-model' }] }));
        return;
      }
      if (rejectOperation) {
        response.statusCode = 503;
        response.end(
          JSON.stringify({ error: { message: 'raw-cli-upstream-sentinel' } }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'K' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected_tcp_address');
      }
      const directory = await mkdtemp(join(tmpdir(), 'stagefabric-qualify-'));
      temporaryDirectories.push(directory);
      const bindingsPath = join(directory, 'bindings.yaml');
      const profilePath = join(directory, 'profile.yaml');
      await writeFile(
        bindingsPath,
        stringify({
          apiVersion: 'stagefabric.dev/v1alpha1',
          kind: 'RuntimeBindings',
          policy: {
            requestTimeoutMs: 1_000,
            maxResponseBytes: 16_384,
            snapshotTtlSeconds: 60,
          },
          targets: [
            {
              targetId: 'cli-runtime',
              provider: {
                kind: 'openai-compatible',
                name: 'cli-provider',
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
              operations: [
                {
                  kind: 'generate-text',
                  operation: 'generate',
                  capabilities: ['text-generation'],
                  model: 'cli-model',
                  input: 'prompt',
                  output: 'text',
                  systemPrompt: 'configured-cli-prompt-sentinel',
                  maxOutputTokens: 64,
                },
              ],
            },
          ],
        }),
        'utf8',
      );
      await writeFile(
        profilePath,
        stringify({
          apiVersion: 'stagefabric.dev/v1alpha1',
          kind: 'RuntimeQualificationProfile',
          limits: {
            totalTimeoutMs: 2_000,
            maxConcurrency: 1,
            maxTargets: 1,
            maxOperations: 1,
            maxGenerationOutputTokensPerCall: 256,
          },
          targets: [{ targetId: 'cli-runtime', operations: ['generate'] }],
        }),
        'utf8',
      );

      const invoke = async () => {
        let output = '';
        let errors = '';
        const exitCode = await runCli(
          [
            'node',
            'stagefabric',
            'qualify',
            '--bindings',
            bindingsPath,
            '--profile',
            profilePath,
          ],
          {
            writeOut: (value) => {
              output += value;
            },
            writeErr: (value) => {
              errors += value;
            },
          },
        );
        return { exitCode, output, errors };
      };

      const passed = await invoke();
      expect(passed.exitCode).toBe(0);
      expect(passed.errors).toBe('');
      expect(JSON.parse(passed.output)).toMatchObject({
        kind: 'RuntimeQualificationReport',
        qualificationScope: 'configured-wire-shape-v1',
        producer: {
          id: 'stagefabric-runtime-qualification',
          version: '1',
        },
        qualified: true,
        results: [
          {
            reasonCode: 'qualified',
            qualifier: { kind: 'openai-compatible', version: '1' },
          },
        ],
      });

      rejectOperation = true;
      const failed = await invoke();
      expect(failed.exitCode).toBe(1);
      expect(JSON.parse(failed.output)).toMatchObject({
        qualified: false,
        results: [{ reasonCode: 'operation_rejected' }],
      });
      expect(JSON.parse(failed.errors)).toEqual({
        error: { code: 'qualification_failed' },
      });

      const serialized = `${passed.output}${failed.output}${failed.errors}`;
      expect(serialized).not.toContain(`127.0.0.1:${address.port}`);
      expect(serialized).not.toContain('cli-model');
      expect(serialized).not.toContain('configured-cli-prompt-sentinel');
      expect(serialized).not.toContain('raw-cli-upstream-sentinel');
      expect(paths).toEqual([
        '/v1/models',
        '/v1/chat/completions',
        '/v1/models',
        '/v1/chat/completions',
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });
});

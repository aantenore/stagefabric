import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { sha256Digest } from '../../src/domain/canonical.js';
import { parseExecutionPlacementEvidence } from '../../src/domain/execution-placement-evidence.js';
import { runCli } from '../../src/entrypoints/cli.js';

const cleanup: (() => Promise<void>)[] = [];
const SECRET_INPUT = 'input-sentinel-that-must-not-enter-evidence';
const SECRET_OUTPUT = 'output-sentinel-that-must-not-enter-evidence';
const RAW_RUN_ID = 'host-run-id-that-must-not-be-stored';

afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

async function liveFixture() {
  const seenPaths: string[] = [];
  let failExecution = false;
  const server = createServer((request, response) => {
    seenPaths.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'test-live-model' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      if (failExecution) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'synthetic_failure' }));
        return;
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: SECRET_OUTPUT },
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
  const evidencePath = join(directory, 'execution-evidence.json');
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
      inputs: { prompt: SECRET_INPUT },
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

  return {
    bundlePath,
    bindingsPath,
    evidencePath,
    seenPaths,
    failExecution: () => {
      failExecution = true;
    },
  };
}

async function invoke(arguments_: readonly string[]) {
  let output = '';
  let errors = '';
  const exitCode = await runCli(['node', 'stagefabric', ...arguments_], {
    writeOut: (value) => {
      output += value;
    },
    writeErr: (value) => {
      errors += value;
    },
  });
  return { exitCode, output, errors };
}

describe('live-run CLI', () => {
  it('probes and executes a real loopback OpenAI-compatible boundary', async () => {
    const fixture = await liveFixture();
    const result = await invoke([
      'run',
      fixture.bundlePath,
      '--bindings',
      fixture.bindingsPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toBe('');
    expect(JSON.parse(result.output)).toMatchObject({
      graphName: 'cli-live',
      placements: [{ stageId: 'answer', targetId: 'loopback-model' }],
      outputs: { 'answer.text': SECRET_OUTPUT },
      trace: [{ reasonCode: 'completed' }],
    });
    expect(result.output).not.toContain(SECRET_INPUT);
    expect(fixture.seenPaths).toEqual(['/v1/models', '/v1/chat/completions']);
  });

  it('writes only content-free evidence and prints digest/path metadata', async () => {
    const fixture = await liveFixture();
    const result = await invoke([
      'run',
      fixture.bundlePath,
      '--bindings',
      fixture.bindingsPath,
      '--evidence-run-id',
      RAW_RUN_ID,
      '--evidence-output',
      fixture.evidencePath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.errors).toBe('');
    const output = JSON.parse(result.output) as {
      evidence: { digest: string; path: string };
    };
    expect(output.evidence).toEqual({
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      path: fixture.evidencePath,
    });
    const source = await readFile(fixture.evidencePath, 'utf8');
    const evidence = parseExecutionPlacementEvidence(JSON.parse(source));
    expect(evidence.digest).toBe(output.evidence.digest);
    expect(evidence.runIdDigest).toBe(sha256Digest(RAW_RUN_ID));
    for (const sentinel of [
      RAW_RUN_ID,
      SECRET_INPUT,
      SECRET_OUTPUT,
      'answer',
      'loopback-model',
      'local',
      'test-live-model',
      '127.0.0.1',
    ]) {
      expect(source).not.toContain(sentinel);
    }
    expect(source).not.toContain(sha256Digest(SECRET_INPUT));
    expect(source).not.toContain(sha256Digest(SECRET_OUTPUT));
  });

  it.each([
    ['--evidence-run-id', RAW_RUN_ID],
    ['--evidence-output', '/tmp/unpaired-stagefabric-evidence.json'],
  ])(
    'requires the evidence options as an all-or-nothing pair',
    async (flag, value) => {
      const result = await invoke([
        'run',
        '/does/not/exist.yaml',
        '--bindings',
        '/does/not/exist-bindings.yaml',
        flag,
        value,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('');
      expect(JSON.parse(result.errors)).toEqual({
        error: { code: 'execution_evidence_option_pair_required' },
      });
    },
  );

  it('does not clobber an existing evidence output', async () => {
    const fixture = await liveFixture();
    const original = 'existing-operator-file';
    await writeFile(fixture.evidencePath, original, 'utf8');

    const result = await invoke([
      'run',
      fixture.bundlePath,
      '--bindings',
      fixture.bindingsPath,
      '--evidence-run-id',
      RAW_RUN_ID,
      '--evidence-output',
      fixture.evidencePath,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('');
    expect(JSON.parse(result.errors)).toEqual({
      error: { code: 'execution_evidence_output_exists' },
    });
    expect(await readFile(fixture.evidencePath, 'utf8')).toBe(original);
  });

  it('never writes evidence when live execution fails', async () => {
    const fixture = await liveFixture();
    fixture.failExecution();

    const result = await invoke([
      'run',
      fixture.bundlePath,
      '--bindings',
      fixture.bindingsPath,
      '--evidence-run-id',
      RAW_RUN_ID,
      '--evidence-output',
      fixture.evidencePath,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('');
    await expect(stat(fixture.evidencePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

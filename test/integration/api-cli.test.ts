import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createDemoPlanRequest,
  DEMO_EVALUATED_AT,
} from '../../src/composition/demo.js';
import { createStageFabricApp } from '../../src/entrypoints/api.js';
import { isDirectCliInvocation, runCli } from '../../src/entrypoints/cli.js';

describe('HTTP API', () => {
  const app = createStageFabricApp({
    now: () => new Date(DEMO_EVALUATED_AT),
  });

  it('reports health and compiles plans', async () => {
    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const { fabric, snapshot, graph } = createDemoPlanRequest();
    const response = await app.request('/v1/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fabric, snapshot, graph }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'ExecutionPlan',
      graphName: 'privacy-first-rag',
    });
  });

  it('rejects oversized API bodies before parsing them', async () => {
    const response = await app.request('/v1/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'request_too_large' },
    });
  });

  it('does not expose a remotely invokable live-run route', async () => {
    const response = await app.request('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it('runs the demo and returns a safe negative-demo failure', async () => {
    const success = await app.request('/v1/demo/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({
      fallbackObserved: true,
      sentinelsReachedDownstream: false,
    });

    const rejected = await app.request('/v1/demo/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leakyRedactor: true }),
    });
    expect(rejected.status).toBe(422);
    const body = await rejected.text();
    expect(JSON.parse(body)).toMatchObject({
      error: {
        code: 'input_policy_rejected',
        stageId: 'embed',
        reasonCode: 'sensitive_data_detected',
      },
    });
    expect(body).not.toContain('ada@example.com');
    expect(body).not.toContain('+39 333 123 4567');
  });
});

describe('CLI', () => {
  it('recognizes an installed package-manager bin symlink by real path', () => {
    const modulePath = resolve('package', 'dist', 'entrypoints', 'cli.js');
    const binPath = resolve('package', 'bin', 'stagefabric');
    const otherPath = resolve('other', 'program');
    const canonical = (path: string) => (path === binPath ? modulePath : path);
    expect(
      isDirectCliInvocation(pathToFileURL(modulePath).href, binPath, canonical),
    ).toBe(true);
    expect(
      isDirectCliInvocation(
        pathToFileURL(modulePath).href,
        otherPath,
        canonical,
      ),
    ).toBe(false);
  });

  it('validates the YAML bundle and runs a content-safe demo', async () => {
    let output = '';
    let errors = '';
    const io = {
      writeOut: (value: string) => {
        output += value;
      },
      writeErr: (value: string) => {
        errors += value;
      },
    };

    const validateCode = await runCli(
      ['node', 'stagefabric', 'validate', resolve('examples/stagefabric.yaml')],
      io,
    );
    expect(validateCode).toBe(0);
    expect(errors).toBe('');
    expect(output).toContain('"valid": true');

    output = '';
    const demoCode = await runCli(['node', 'stagefabric', 'demo'], io);
    expect(demoCode).toBe(0);
    expect(output).toContain('"fallbackObserved": true');
    expect(output).not.toContain('ada@example.com');
    expect(output).not.toContain('+39 333 123 4567');

    output = '';
    const versionCode = await runCli(['node', 'stagefabric', '--version'], io);
    expect(versionCode).toBe(0);
    expect(output).toBe('0.4.0-alpha.1\n');
  });
});

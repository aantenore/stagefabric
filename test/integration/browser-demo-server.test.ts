import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserDemoApp } from '../../src/entrypoints/browser-demo.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stagefabric-browser-demo-'));
  temporaryRoots.push(root);
  await writeFile(join(root, 'index.html'), '<h1>Browser Privacy Bridge</h1>');
  return root;
}

describe('browser demo server', () => {
  it('serves the built app from loopback-oriented static middleware with security headers', async () => {
    const app = createBrowserDemoApp({ root: await fixtureRoot() });
    const response = await app.request('/');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Browser Privacy Bridge');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get('cross-origin-opener-policy')).toBe(
      'same-origin',
    );
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('fails closed for missing builds and paths outside the asset root', async () => {
    expect(() =>
      createBrowserDemoApp({
        root: join(tmpdir(), 'stagefabric-missing-demo'),
      }),
    ).toThrow('browser_demo_not_built');

    const app = createBrowserDemoApp({ root: await fixtureRoot() });
    const response = await app.request('/%2e%2e/package.json');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'browser_demo_asset_not_found' },
    });
  });
});

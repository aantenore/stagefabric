import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

const DEFAULT_BROWSER_DEMO_ROOT = fileURLToPath(
  new URL('../../dist/browser-demo/', import.meta.url),
);

export interface BrowserDemoAppOptions {
  readonly root?: string;
}

export function createBrowserDemoApp(
  options: BrowserDemoAppOptions = {},
): Hono {
  const root = options.root ?? DEFAULT_BROWSER_DEMO_ROOT;
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error('browser_demo_not_built');
  }

  const app = new Hono();
  app.use('*', async (context, next) => {
    await next();
    context.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    context.header('Cross-Origin-Opener-Policy', 'same-origin');
    context.header('Cross-Origin-Resource-Policy', 'same-origin');
    context.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    context.header('Referrer-Policy', 'no-referrer');
    context.header('X-Frame-Options', 'DENY');
    context.header('X-Content-Type-Options', 'nosniff');
  });
  app.use(
    '*',
    serveStatic({
      root,
      rewriteRequestPath: (path) => (path === '/' ? '/index.html' : path),
    }),
  );
  app.notFound((context) =>
    context.json({ error: { code: 'browser_demo_asset_not_found' } }, 404),
  );
  return app;
}

export interface StartBrowserDemoServerOptions extends BrowserDemoAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly app?: Hono;
}

export function startBrowserDemoServer(
  options: StartBrowserDemoServerOptions = {},
): ServerType {
  const app = options.app ?? createBrowserDemoApp(options);
  return serve({
    fetch: app.fetch,
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 4173,
  });
}

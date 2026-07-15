import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { ExecutionError } from '../application/executor.js';
import { planStageGraph, PlannerError } from '../application/planner.js';
import { runDemo, type DemoRunResult } from '../composition/demo.js';
import { safeErrorBody } from './safe-error.js';

const demoRequestSchema = z
  .object({
    leakyRedactor: z.boolean().optional(),
  })
  .strict();
const planRequestEnvelopeSchema = z
  .object({
    fabric: z.unknown(),
    snapshot: z.unknown(),
    graph: z.unknown(),
  })
  .strict();

class RequestJsonError extends Error {}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RequestJsonError();
  }
}

async function readOptionalJson(request: Request): Promise<unknown> {
  const source = await request.text();
  if (source.trim() === '') return {};
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new RequestJsonError();
  }
}

export interface StageFabricAppOptions {
  readonly demoRunner?: (options?: {
    leakyRedactor?: boolean;
  }) => Promise<DemoRunResult>;
  readonly now?: () => Date;
}

export function createStageFabricApp(
  options: StageFabricAppOptions = {},
): Hono {
  const app = new Hono();
  const demoRunner = options.demoRunner ?? runDemo;
  const now = options.now ?? (() => new Date());

  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (context) =>
        context.json({ error: { code: 'request_too_large' } }, 413),
    }),
  );

  app.get('/healthz', (context) => context.json({ status: 'ok' }));

  app.post('/v1/plans', async (context) => {
    try {
      const body = await readJson(context.req.raw);
      const request = planRequestEnvelopeSchema.parse(body);
      return context.json(
        planStageGraph({ ...request, evaluatedAt: now().toISOString() }),
        200,
      );
    } catch (error) {
      if (error instanceof RequestJsonError) {
        return context.json({ error: { code: 'invalid_json' } }, 400);
      }
      if (error instanceof z.ZodError)
        return context.json(safeErrorBody(error), 400);
      if (error instanceof PlannerError)
        return context.json(safeErrorBody(error), 422);
      return context.json(safeErrorBody(error), 500);
    }
  });

  app.post('/v1/demo/runs', async (context) => {
    try {
      const raw = await readOptionalJson(context.req.raw);
      const parsed = demoRequestSchema.parse(raw);
      const demoOptions =
        parsed.leakyRedactor === undefined
          ? {}
          : { leakyRedactor: parsed.leakyRedactor };
      return context.json(await demoRunner(demoOptions), 200);
    } catch (error) {
      if (error instanceof RequestJsonError) {
        return context.json({ error: { code: 'invalid_json' } }, 400);
      }
      if (error instanceof z.ZodError)
        return context.json(safeErrorBody(error), 400);
      if (error instanceof ExecutionError)
        return context.json(safeErrorBody(error), 422);
      return context.json(safeErrorBody(error), 500);
    }
  });

  app.notFound((context) =>
    context.json({ error: { code: 'not_found' } }, 404),
  );
  return app;
}

export interface StartServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly app?: Hono;
}

export function startStageFabricServer(
  options: StartServerOptions = {},
): ServerType {
  const app = options.app ?? createStageFabricApp();
  return serve({
    fetch: app.fetch,
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 8787,
  });
}

import { readFile } from 'node:fs/promises';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import type { PlanRequest } from '../application/planner.js';
import {
  capabilitySnapshotContentSchema,
  capabilitySnapshotSchema,
  fabricSchema,
  stageGraphSchema,
  timestampSchema,
} from '../domain/schema.js';
import { sealCapabilitySnapshot } from '../domain/snapshot.js';

const bundleSchema = z
  .object({
    evaluatedAt: timestampSchema,
    fabric: fabricSchema,
    snapshot: z.unknown(),
    graph: stageGraphSchema,
  })
  .strict();

export class ConfigBundleError extends Error {
  readonly code: 'yaml_invalid' | 'bundle_invalid' | 'snapshot_invalid';
  readonly issues: readonly unknown[];

  constructor(
    code: 'yaml_invalid' | 'bundle_invalid' | 'snapshot_invalid',
    issues: readonly unknown[] = [],
  ) {
    super(code);
    this.name = 'ConfigBundleError';
    this.code = code;
    this.issues = issues;
  }
}

function safeIssues(error: z.ZodError): readonly unknown[] {
  return error.issues.map((issue) => ({ code: issue.code }));
}

export function parseConfigBundle(source: string): PlanRequest {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw new ConfigBundleError('yaml_invalid');

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ConfigBundleError('yaml_invalid');
  }

  const bundle = bundleSchema.safeParse(raw);
  if (!bundle.success)
    throw new ConfigBundleError('bundle_invalid', safeIssues(bundle.error));

  const sealed = capabilitySnapshotSchema.safeParse(bundle.data.snapshot);
  if (sealed.success) {
    return {
      evaluatedAt: bundle.data.evaluatedAt,
      fabric: bundle.data.fabric,
      snapshot: sealed.data,
      graph: bundle.data.graph,
    };
  }
  const content = capabilitySnapshotContentSchema.safeParse(
    bundle.data.snapshot,
  );
  if (!content.success)
    throw new ConfigBundleError('snapshot_invalid', safeIssues(content.error));
  return {
    evaluatedAt: bundle.data.evaluatedAt,
    fabric: bundle.data.fabric,
    snapshot: sealCapabilitySnapshot(content.data),
    graph: bundle.data.graph,
  };
}

export async function loadConfigBundle(path: string): Promise<PlanRequest> {
  return parseConfigBundle(await readFile(path, 'utf8'));
}

import { readFile, stat } from 'node:fs/promises';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  runtimeBindingsContentSchema,
  runtimeBindingsSchema,
  sealRuntimeBindings,
  verifyRuntimeBindingsDigest,
  type RuntimeBindings,
} from '../domain/runtime-bindings.js';
import {
  fabricSchema,
  stageGraphSchema,
  type Fabric,
  type StageGraph,
} from '../domain/schema.js';

export const MAX_LIVE_RUN_BUNDLE_BYTES = 2 * 1_024 * 1_024;

const liveRunBundleSchema = z
  .object({
    fabric: fabricSchema,
    graph: stageGraphSchema,
    inputs: z.record(z.string().min(1).max(128), z.unknown()),
  })
  .strict();

export type LiveRunBundleErrorCode =
  | 'live_bundle_too_large'
  | 'live_bundle_yaml_invalid'
  | 'live_bundle_invalid'
  | 'runtime_bindings_invalid'
  | 'runtime_binding_digest_mismatch';

export class LiveRunBundleError extends Error {
  readonly code: LiveRunBundleErrorCode;
  readonly issues: readonly unknown[];

  constructor(code: LiveRunBundleErrorCode, issues: readonly unknown[] = []) {
    super(code);
    this.name = 'LiveRunBundleError';
    this.code = code;
    this.issues = issues;
  }
}

export interface LiveRunBundle {
  readonly fabric: Fabric;
  readonly graph: StageGraph;
  readonly inputs: Readonly<Record<string, unknown>>;
}

function safeIssues(error: z.ZodError): readonly unknown[] {
  return error.issues.map((issue) => ({ code: issue.code }));
}

function hasDigest(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, 'digest')
  );
}

export function parseLiveRunBundle(source: string): LiveRunBundle {
  if (Buffer.byteLength(source, 'utf8') > MAX_LIVE_RUN_BUNDLE_BYTES) {
    throw new LiveRunBundleError('live_bundle_too_large');
  }

  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new LiveRunBundleError('live_bundle_yaml_invalid');
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new LiveRunBundleError('live_bundle_yaml_invalid');
  }
  const bundle = liveRunBundleSchema.safeParse(raw);
  if (!bundle.success) {
    throw new LiveRunBundleError(
      'live_bundle_invalid',
      safeIssues(bundle.error),
    );
  }

  return {
    fabric: bundle.data.fabric,
    graph: bundle.data.graph,
    inputs: bundle.data.inputs,
  };
}

/**
 * Parses the operator-selected runtime registry. This file is a trust boundary,
 * not part of the application graph; its SHA digest provides integrity only.
 */
export function parseRuntimeBindingsFile(source: string): RuntimeBindings {
  if (Buffer.byteLength(source, 'utf8') > MAX_LIVE_RUN_BUNDLE_BYTES) {
    throw new LiveRunBundleError('live_bundle_too_large');
  }
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new LiveRunBundleError('live_bundle_yaml_invalid');
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new LiveRunBundleError('live_bundle_yaml_invalid');
  }

  if (hasDigest(raw)) {
    const sealed = runtimeBindingsSchema.safeParse(raw);
    if (!sealed.success) {
      throw new LiveRunBundleError(
        'runtime_bindings_invalid',
        safeIssues(sealed.error),
      );
    }
    if (!verifyRuntimeBindingsDigest(sealed.data)) {
      throw new LiveRunBundleError('runtime_binding_digest_mismatch');
    }
    return sealed.data;
  } else {
    const content = runtimeBindingsContentSchema.safeParse(raw);
    if (!content.success) {
      throw new LiveRunBundleError(
        'runtime_bindings_invalid',
        safeIssues(content.error),
      );
    }
    return sealRuntimeBindings(content.data);
  }
}

export async function loadLiveRunBundle(path: string): Promise<LiveRunBundle> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_LIVE_RUN_BUNDLE_BYTES) {
    throw new LiveRunBundleError('live_bundle_too_large');
  }
  return parseLiveRunBundle(await readFile(path, 'utf8'));
}

export async function loadRuntimeBindingsFile(
  path: string,
): Promise<RuntimeBindings> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_LIVE_RUN_BUNDLE_BYTES) {
    throw new LiveRunBundleError('live_bundle_too_large');
  }
  return parseRuntimeBindingsFile(await readFile(path, 'utf8'));
}

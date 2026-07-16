import { readFile, stat } from 'node:fs/promises';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  runtimeQualificationProfileSchema,
  type RuntimeQualificationProfile,
} from '../domain/runtime-qualification.js';

export const MAX_RUNTIME_QUALIFICATION_PROFILE_BYTES = 256 * 1_024;

export type RuntimeQualificationProfileErrorCode =
  | 'qualification_profile_invalid'
  | 'qualification_profile_too_large'
  | 'qualification_profile_yaml_invalid';

export class RuntimeQualificationProfileError extends Error {
  readonly code: RuntimeQualificationProfileErrorCode;
  readonly issues: readonly unknown[];

  constructor(
    code: RuntimeQualificationProfileErrorCode,
    issues: readonly unknown[] = [],
  ) {
    super(code);
    this.name = 'RuntimeQualificationProfileError';
    this.code = code;
    this.issues = issues;
  }
}

function safeIssues(error: z.ZodError): readonly unknown[] {
  return error.issues.map((issue) => ({ code: issue.code }));
}

export function parseRuntimeQualificationProfile(
  source: string,
): RuntimeQualificationProfile {
  if (
    Buffer.byteLength(source, 'utf8') > MAX_RUNTIME_QUALIFICATION_PROFILE_BYTES
  ) {
    throw new RuntimeQualificationProfileError(
      'qualification_profile_too_large',
    );
  }

  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new RuntimeQualificationProfileError(
      'qualification_profile_yaml_invalid',
    );
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new RuntimeQualificationProfileError(
      'qualification_profile_yaml_invalid',
    );
  }
  const parsed = runtimeQualificationProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RuntimeQualificationProfileError(
      'qualification_profile_invalid',
      safeIssues(parsed.error),
    );
  }
  return parsed.data;
}

export async function loadRuntimeQualificationProfile(
  path: string,
): Promise<RuntimeQualificationProfile> {
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    metadata.size > MAX_RUNTIME_QUALIFICATION_PROFILE_BYTES
  ) {
    throw new RuntimeQualificationProfileError(
      'qualification_profile_too_large',
    );
  }
  return parseRuntimeQualificationProfile(await readFile(path, 'utf8'));
}

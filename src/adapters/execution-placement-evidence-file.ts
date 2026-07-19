import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { canonicalJson } from '../domain/canonical.js';
import {
  parseExecutionPlacementEvidence,
  type ExecutionPlacementEvidence,
} from '../domain/execution-placement-evidence.js';

export type ExecutionPlacementEvidenceFileErrorCode =
  | 'execution_evidence_invalid'
  | 'execution_evidence_output_exists'
  | 'execution_evidence_write_failed';

export class ExecutionPlacementEvidenceFileError extends Error {
  readonly code: ExecutionPlacementEvidenceFileErrorCode;

  constructor(code: ExecutionPlacementEvidenceFileErrorCode) {
    super(code);
    this.name = 'ExecutionPlacementEvidenceFileError';
    this.code = code;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function noClobberError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EEXIST' || code === 'ELOOP' || code === 'EISDIR';
}

/** Writes one verified evidence artifact without following or replacing a path. */
export async function writeExecutionPlacementEvidenceFile(
  path: string,
  input: unknown,
): Promise<ExecutionPlacementEvidence> {
  let evidence: ExecutionPlacementEvidence;
  let source: string;
  try {
    evidence = parseExecutionPlacementEvidence(input);
    source = `${canonicalJson(evidence)}\n`;
  } catch {
    throw new ExecutionPlacementEvidenceFileError('execution_evidence_invalid');
  }

  let file;
  let failure: unknown;
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(source, 'utf8');
    await file.sync();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await file?.close();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) {
    // Do not unlink by pathname after opening. A process with write access to
    // the parent directory could replace that name while this handle is open,
    // turning best-effort cleanup into deletion of an unrelated entry. A
    // post-open failure can therefore leave a private, unconfirmed file for the
    // operator to inspect and remove explicitly.
    throw new ExecutionPlacementEvidenceFileError(
      noClobberError(failure)
        ? 'execution_evidence_output_exists'
        : 'execution_evidence_write_failed',
    );
  }

  return evidence;
}

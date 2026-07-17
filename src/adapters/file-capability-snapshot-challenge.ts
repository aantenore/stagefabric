import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import {
  capabilitySnapshotChallengeReceiptSchema,
  type CapabilitySnapshotChallengeReceipt,
} from '../domain/capability-snapshot-attestation.js';
import { sha256DigestSchema, timestampSchema } from '../domain/schema.js';
import type {
  CapabilitySnapshotChallengeConsumer,
  ConsumeCapabilitySnapshotChallengeRequest,
} from '../ports/capability-snapshot-challenge-consumer.js';

export type FileChallengeErrorCode =
  | 'challenge_already_exists'
  | 'challenge_consume_failed'
  | 'challenge_issue_failed'
  | 'challenge_ttl_invalid';

export class FileChallengeError extends Error {
  readonly code: FileChallengeErrorCode;

  constructor(code: FileChallengeErrorCode) {
    super(code);
    this.name = 'FileChallengeError';
    this.code = code;
  }
}

export interface IssueCapabilitySnapshotChallengeOptions {
  readonly path: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
}

const consumeRequestSchema = z
  .object({
    challengeDigest: sha256DigestSchema,
    authorizationDigest: sha256DigestSchema,
    consumedAt: timestampSchema,
  })
  .strict();

function exclusiveFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

async function syncDirectory(path: string): Promise<void> {
  // Node does not expose a portable directory fsync on Windows. The marker
  // file itself is still fsynced and closed before execution is admitted.
  if (process.platform === 'win32') return;
  let directory;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } finally {
    await directory?.close();
  }
}

async function ensurePrivateStore(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!exclusiveFileError(error)) throw error;
  }
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
  ) {
    throw new FileChallengeError('challenge_consume_failed');
  }
  // Syncing the parent on every use closes the concurrent first-creation gap:
  // another consumer cannot admit execution before the store entry is durable.
  await syncDirectory(dirname(path));
}

function timestamp(now: () => Date): Date {
  try {
    const value = now();
    if (!Number.isFinite(value.getTime())) throw new TypeError('invalid');
    return value;
  } catch {
    throw new FileChallengeError('challenge_issue_failed');
  }
}

export async function issueCapabilitySnapshotChallengeFile(
  options: IssueCapabilitySnapshotChallengeOptions,
): Promise<CapabilitySnapshotChallengeReceipt> {
  if (
    !Number.isInteger(options.ttlSeconds) ||
    options.ttlSeconds < 1 ||
    options.ttlSeconds > 3_600
  ) {
    throw new FileChallengeError('challenge_ttl_invalid');
  }

  const issued = timestamp(options.now ?? (() => new Date()));
  let value: string;
  try {
    value = Buffer.from((options.random ?? randomBytes)(32)).toString(
      'base64url',
    );
  } catch {
    throw new FileChallengeError('challenge_issue_failed');
  }
  const parsedChallenge = capabilitySnapshotChallengeReceiptSchema.safeParse({
    value,
    audience: options.audience,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(
      issued.getTime() + options.ttlSeconds * 1_000,
    ).toISOString(),
  });
  if (!parsedChallenge.success) {
    throw new FileChallengeError('challenge_issue_failed');
  }
  const challenge = parsedChallenge.data;

  let file;
  try {
    file = await open(options.path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(challenge, null, 2)}\n`, 'utf8');
    await file.sync();
  } catch (error) {
    if (exclusiveFileError(error)) {
      throw new FileChallengeError('challenge_already_exists');
    }
    throw new FileChallengeError('challenge_issue_failed');
  } finally {
    try {
      await file?.close();
    } catch {
      // The file was fsynced before this point; never expose a raw close error.
    }
  }
  return challenge;
}

class FileCapabilitySnapshotChallengeConsumer implements CapabilitySnapshotChallengeConsumer {
  constructor(private readonly storePath: string) {}

  async consume(
    request: ConsumeCapabilitySnapshotChallengeRequest,
  ): Promise<boolean> {
    const parsed = consumeRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new FileChallengeError('challenge_consume_failed');
    }
    const markerPath = join(
      this.storePath,
      `${parsed.data.challengeDigest.slice('sha256:'.length)}.consumed`,
    );
    let file;
    try {
      await ensurePrivateStore(this.storePath);
      file = await open(markerPath, 'wx', 0o600);
      await file.writeFile(
        `${JSON.stringify({
          apiVersion: 'stagefabric.dev/v1alpha1',
          kind: 'ConsumedCapabilitySnapshotChallenge',
          challengeDigest: parsed.data.challengeDigest,
          authorizationDigest: parsed.data.authorizationDigest,
          consumedAt: parsed.data.consumedAt,
        })}\n`,
        'utf8',
      );
      await file.sync();
      await file.close();
      file = undefined;
      await syncDirectory(this.storePath);
      return true;
    } catch (error) {
      if (exclusiveFileError(error)) return false;
      throw new FileChallengeError('challenge_consume_failed');
    } finally {
      try {
        await file?.close();
      } catch {
        // A consumed marker is fail-closed even if close reports an error.
      }
    }
  }
}

export function createFileCapabilitySnapshotChallengeConsumer(
  storePath: string,
): CapabilitySnapshotChallengeConsumer {
  return new FileCapabilitySnapshotChallengeConsumer(storePath);
}

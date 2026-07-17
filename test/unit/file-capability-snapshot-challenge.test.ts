import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileCapabilitySnapshotChallengeConsumer,
  issueCapabilitySnapshotChallengeFile,
} from '../../src/adapters/file-capability-snapshot-challenge.js';

const directories: string[] = [];

async function challengePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stagefabric-challenge-'));
  directories.push(directory);
  return join(directory, 'challenge.json');
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('file capability snapshot challenge', () => {
  it('issues a deterministic, private 256-bit challenge lease exclusively', async () => {
    const path = await challengePath();
    const challenge = await issueCapabilitySnapshotChallengeFile({
      path,
      audience: 'stagefabric://control-plane/test',
      ttlSeconds: 90,
      now: () => new Date('2026-07-17T05:00:00.000Z'),
      random: () => new Uint8Array(32).fill(7),
    });

    expect(challenge).toEqual({
      value: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      audience: 'stagefabric://control-plane/test',
      issuedAt: '2026-07-17T05:00:00.000Z',
      expiresAt: '2026-07-17T05:01:30.000Z',
    });
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o077).toBe(0);
    }

    await expect(
      issueCapabilitySnapshotChallengeFile({
        path,
        audience: challenge.audience,
        ttlSeconds: 90,
      }),
    ).rejects.toMatchObject({ code: 'challenge_already_exists' });
  });

  it('allows exactly one concurrent consumer and persists no raw challenge', async () => {
    const path = await challengePath();
    const store = join(dirname(path), 'challenge-store');
    const firstConsumer = createFileCapabilitySnapshotChallengeConsumer(store);
    const secondConsumer = createFileCapabilitySnapshotChallengeConsumer(store);
    const request = {
      challengeDigest: `sha256:${'1'.repeat(64)}` as const,
      authorizationDigest: `sha256:${'2'.repeat(64)}` as const,
      consumedAt: '2026-07-17T05:00:30.000Z',
    };

    const outcomes = await Promise.all([
      firstConsumer.consume(request),
      secondConsumer.consume(request),
    ]);

    expect(outcomes.sort()).toEqual([false, true]);
    const marker = await readFile(
      join(store, `${'1'.repeat(64)}.consumed`),
      'utf8',
    );
    expect(marker).toContain(request.challengeDigest);
    expect(marker).toContain(request.authorizationDigest);
    expect(marker).not.toContain('BwcHBwcH');
  });

  it('keys replay protection by challenge digest, not receipt path', async () => {
    const firstPath = await challengePath();
    const secondPath = await challengePath();
    const store = join(dirname(firstPath), 'shared-store');
    const request = {
      challengeDigest: `sha256:${'a'.repeat(64)}` as const,
      authorizationDigest: `sha256:${'b'.repeat(64)}` as const,
      consumedAt: '2026-07-17T05:00:30.000Z',
    };

    expect(firstPath).not.toBe(secondPath);
    await expect(
      createFileCapabilitySnapshotChallengeConsumer(store).consume(request),
    ).resolves.toBe(true);
    await expect(
      createFileCapabilitySnapshotChallengeConsumer(store).consume(request),
    ).resolves.toBe(false);
  });

  it('normalizes invalid TTL and random sources', async () => {
    await expect(
      issueCapabilitySnapshotChallengeFile({
        path: await challengePath(),
        audience: 'stagefabric://control-plane/test',
        ttlSeconds: 0,
      }),
    ).rejects.toMatchObject({ code: 'challenge_ttl_invalid' });

    await expect(
      issueCapabilitySnapshotChallengeFile({
        path: await challengePath(),
        audience: 'stagefabric://control-plane/test',
        ttlSeconds: 30,
        random: () => new Uint8Array(31),
      }),
    ).rejects.toMatchObject({ code: 'challenge_issue_failed' });
  });
});

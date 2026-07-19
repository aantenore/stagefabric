import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ExecutionPlacementEvidenceFileError,
  writeExecutionPlacementEvidenceFile,
} from '../../src/adapters/execution-placement-evidence-file.js';
import { sha256Digest } from '../../src/domain/canonical.js';
import {
  parseExecutionPlacementEvidence,
  sealExecutionPlacementEvidence,
} from '../../src/domain/execution-placement-evidence.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stagefabric-evidence-'));
  directories.push(directory);
  return directory;
}

function evidence() {
  const stageIdDigest = sha256Digest('stage');
  const targetIdDigest = sha256Digest('target');
  const zoneDigest = sha256Digest('zone');
  const adapterKindDigest = sha256Digest('adapter');
  return sealExecutionPlacementEvidence({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'ExecutionPlacementEvidence',
    producer: 'stagefabric',
    disclosure: 'content-free',
    authority: 'observation-only',
    runIdDigest: sha256Digest('run'),
    observedAt: '2026-07-19T15:00:01.000Z',
    planDigest: sha256Digest('plan'),
    bindingDigest: sha256Digest('binding'),
    snapshotDigest: sha256Digest('snapshot'),
    egressDigest: sha256Digest('egress'),
    placements: [
      {
        stageIdDigest,
        targetIdDigest,
        zoneDigest,
        adapterKindDigest,
        attempt: 1,
        status: 'succeeded',
        reasonCode: 'completed',
      },
    ],
    trace: [
      {
        stageIdDigest,
        targetIdDigest,
        zoneDigest,
        adapterKindDigest,
        attempt: 1,
        status: 'succeeded',
        reasonCode: 'completed',
      },
    ],
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('execution placement evidence file', () => {
  it('writes verified canonical JSON exclusively with private permissions', async () => {
    const path = join(await temporaryDirectory(), 'evidence.json');
    const expected = evidence();

    await expect(
      writeExecutionPlacementEvidenceFile(path, expected),
    ).resolves.toEqual(expected);
    expect(
      parseExecutionPlacementEvidence(JSON.parse(await readFile(path, 'utf8'))),
    ).toEqual(expected);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o077).toBe(0);
    }
  });

  it('never replaces an existing path', async () => {
    const path = join(await temporaryDirectory(), 'evidence.json');
    const original = 'operator-owned-existing-content';
    await writeFile(path, original, 'utf8');

    await expect(
      writeExecutionPlacementEvidenceFile(path, evidence()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExecutionPlacementEvidenceFileError>>({
        code: 'execution_evidence_output_exists',
      }),
    );
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it.runIf(process.platform !== 'win32')(
    'does not follow a symbolic-link output path',
    async () => {
      const directory = await temporaryDirectory();
      const target = join(directory, 'target.json');
      const output = join(directory, 'evidence.json');
      const original = 'symlink-target-must-not-change';
      await writeFile(target, original, 'utf8');
      await symlink(target, output);

      await expect(
        writeExecutionPlacementEvidenceFile(output, evidence()),
      ).rejects.toMatchObject({ code: 'execution_evidence_output_exists' });
      expect(await readFile(target, 'utf8')).toBe(original);
    },
  );

  it('rejects invalid evidence before creating the output path', async () => {
    const path = join(await temporaryDirectory(), 'evidence.json');
    const invalid = { ...evidence(), digest: sha256Digest('tampered') };

    await expect(
      writeExecutionPlacementEvidenceFile(path, invalid),
    ).rejects.toMatchObject({ code: 'execution_evidence_invalid' });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

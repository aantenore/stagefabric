import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  loadCapabilitySnapshotAttestationBundle,
  MAX_CAPABILITY_ATTESTATION_CONFIG_BYTES,
  parseCapabilitySnapshot,
  parseCapabilitySnapshotChallengeReceiptFile,
  parseCapabilitySnapshotTrustPolicyFile,
  parseRuntimeQualificationReport,
} from '../../src/adapters/capability-snapshot-attestation-files.js';
import { MAX_SIGSTORE_BUNDLE_BYTES } from '../../src/adapters/sigstore-capability-snapshot-attestation-verifier.js';
import { computeRuntimeQualificationProfileDigest } from '../../src/domain/runtime-qualification.js';
import { sealRuntimeQualificationReport } from '../../src/domain/runtime-qualification.js';
import { sealCapabilitySnapshot } from '../../src/domain/snapshot.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'stagefabric-attestation-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('capability snapshot attestation files', () => {
  it('parses strict policy and challenge documents without executable input', () => {
    const digest = `sha256:${'0'.repeat(64)}`;
    const policy = parseCapabilitySnapshotTrustPolicyFile(
      stringify({
        apiVersion: 'stagefabric.dev/v1alpha1',
        kind: 'CapabilitySnapshotTrustPolicy',
        certificateIssuer: 'https://token.actions.githubusercontent.com',
        signerIdentity: {
          type: 'uri',
          value:
            'https://github.com/aantenore/stagefabric/.github/workflows/attest.yml@refs/heads/main',
        },
        audience: 'stagefabric://control-plane/test',
        certificateThreshold: 1,
        transparencyLogThreshold: 1,
        fabricDigest: digest,
        qualificationProfileDigest: digest,
        maxSnapshotAgeSeconds: 60,
        maxSnapshotTtlSeconds: 90,
        clockSkewSeconds: 5,
      }),
    );
    expect(policy.signerIdentity.type).toBe('uri');

    expect(() =>
      parseCapabilitySnapshotChallengeReceiptFile(
        stringify({
          value: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
          audience: policy.audience,
          issuedAt: '2026-07-17T05:00:00.000Z',
          expiresAt: '2026-07-17T05:01:00.000Z',
          module: './untrusted-code.js',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'challenge_invalid' }));
  });

  it('verifies sealed snapshot and qualification report digests', () => {
    const bindingDigest = `sha256:${'1'.repeat(64)}` as const;
    const snapshot = sealCapabilitySnapshot({
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'CapabilitySnapshot',
      bindingDigest,
      observedAt: '2026-07-17T05:00:00.000Z',
      expiresAt: '2026-07-17T05:01:00.000Z',
      targets: [
        {
          targetId: 'local-runtime',
          healthy: true,
          capabilities: ['stagefabric.operation/generate'],
        },
      ],
    });
    expect(parseCapabilitySnapshot(stringify(snapshot))).toEqual(snapshot);
    expect(() =>
      parseCapabilitySnapshot(
        stringify({ ...snapshot, digest: `sha256:${'2'.repeat(64)}` }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'snapshot_digest_mismatch' }),
    );

    const profile = {
      apiVersion: 'stagefabric.dev/v1alpha1' as const,
      kind: 'RuntimeQualificationProfile' as const,
      limits: {
        totalTimeoutMs: 1_000,
        maxConcurrency: 1,
        maxTargets: 1,
        maxOperations: 1,
        maxGenerationOutputTokensPerCall: 16,
      },
      targets: [{ targetId: 'local-runtime', operations: ['generate'] }],
    };
    const report = sealRuntimeQualificationReport({
      apiVersion: 'stagefabric.dev/v1alpha1',
      kind: 'RuntimeQualificationReport',
      bindingDigest,
      profileDigest: computeRuntimeQualificationProfileDigest(profile),
      qualificationScope: 'configured-wire-shape-v1',
      producer: { id: 'stagefabric-runtime-qualification', version: '1' },
      qualified: true,
      results: [
        {
          targetId: 'local-runtime',
          operation: 'generate',
          operationKind: 'generate-text',
          status: 'qualified',
          reasonCode: 'qualified',
          qualifier: { kind: 'openai-compatible', version: 'test-v1' },
        },
      ],
    });
    expect(parseRuntimeQualificationReport(stringify(report))).toEqual(report);
    expect(() =>
      parseRuntimeQualificationReport(
        stringify({ ...report, digest: `sha256:${'3'.repeat(64)}` }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'qualification_report_digest_mismatch' }),
    );
  });

  it('returns copied bundle bytes and rejects oversized or non-file inputs', async () => {
    const directory = await temporaryDirectory();
    const bundlePath = join(directory, 'bundle.sigstore.json');
    await writeFile(bundlePath, '{"mediaType":"test"}', 'utf8');
    const loaded = await loadCapabilitySnapshotAttestationBundle(bundlePath);
    expect(new TextDecoder().decode(loaded)).toBe('{"mediaType":"test"}');

    const oversizedPath = join(directory, 'oversized.bundle');
    await writeFile(oversizedPath, Buffer.alloc(MAX_SIGSTORE_BUNDLE_BYTES + 1));
    await expect(
      loadCapabilitySnapshotAttestationBundle(oversizedPath),
    ).rejects.toMatchObject({ code: 'attestation_file_too_large' });
    await expect(
      loadCapabilitySnapshotAttestationBundle(directory),
    ).rejects.toMatchObject({ code: 'attestation_file_invalid' });
  });

  it('rejects configuration text over its explicit ceiling', () => {
    expect(() =>
      parseCapabilitySnapshotTrustPolicyFile(
        `padding: ${'x'.repeat(MAX_CAPABILITY_ATTESTATION_CONFIG_BYTES)}`,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'attestation_file_too_large' }),
    );
  });
});

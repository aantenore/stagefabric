import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  capabilitySnapshotChallengeReceiptSchema,
  capabilitySnapshotTrustPolicySchema,
  type CapabilitySnapshotChallengeReceipt,
  type CapabilitySnapshotTrustPolicy,
} from '../domain/capability-snapshot-attestation.js';
import {
  runtimeQualificationReportSchema,
  verifyRuntimeQualificationReportDigest,
  type RuntimeQualificationReport,
} from '../domain/runtime-qualification.js';
import {
  capabilitySnapshotSchema,
  type CapabilitySnapshot,
} from '../domain/schema.js';
import { verifyCapabilitySnapshotDigest } from '../domain/snapshot.js';
import { MAX_SIGSTORE_BUNDLE_BYTES } from './sigstore-capability-snapshot-attestation-verifier.js';

export const MAX_CAPABILITY_ATTESTATION_CONFIG_BYTES = 256 * 1_024;

export type CapabilityAttestationFileErrorCode =
  | 'attestation_file_invalid'
  | 'attestation_file_too_large'
  | 'attestation_yaml_invalid'
  | 'challenge_invalid'
  | 'qualification_report_digest_mismatch'
  | 'qualification_report_invalid'
  | 'snapshot_digest_mismatch'
  | 'snapshot_invalid'
  | 'trust_policy_invalid';

export class CapabilityAttestationFileError extends Error {
  readonly code: CapabilityAttestationFileErrorCode;

  constructor(code: CapabilityAttestationFileErrorCode) {
    super(code);
    this.name = 'CapabilityAttestationFileError';
    this.code = code;
  }
}

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new CapabilityAttestationFileError('attestation_yaml_invalid');
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new CapabilityAttestationFileError('attestation_yaml_invalid');
  }
}

function parseStrict<T>(
  source: string,
  schema: z.ZodType<T>,
  code: CapabilityAttestationFileErrorCode,
): T {
  if (
    Buffer.byteLength(source, 'utf8') > MAX_CAPABILITY_ATTESTATION_CONFIG_BYTES
  ) {
    throw new CapabilityAttestationFileError('attestation_file_too_large');
  }
  const parsed = schema.safeParse(parseYaml(source));
  if (!parsed.success) throw new CapabilityAttestationFileError(code);
  return parsed.data;
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new CapabilityAttestationFileError('attestation_file_invalid');
    }
    if (metadata.size > maxBytes) {
      throw new CapabilityAttestationFileError('attestation_file_too_large');
    }
    // Read at most max+1 from the already-open descriptor. This cannot block
    // on a FIFO and cannot allocate an unbounded file that grows after fstat.
    const source = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < source.byteLength) {
      const { bytesRead } = await file.read(
        source,
        offset,
        source.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new CapabilityAttestationFileError('attestation_file_too_large');
    }
    const afterRead = await file.stat();
    if (
      !afterRead.isFile() ||
      afterRead.size !== metadata.size ||
      afterRead.mtimeMs !== metadata.mtimeMs ||
      afterRead.ctimeMs !== metadata.ctimeMs
    ) {
      throw new CapabilityAttestationFileError('attestation_file_invalid');
    }
    return Buffer.from(source.subarray(0, offset));
  } catch (error) {
    if (error instanceof CapabilityAttestationFileError) throw error;
    throw new CapabilityAttestationFileError('attestation_file_invalid');
  } finally {
    try {
      await file?.close();
    } catch {
      // The caller receives copied bytes; never expose a raw close error.
    }
  }
}

async function readBoundedUtf8(path: string): Promise<string> {
  const source = await readBoundedFile(
    path,
    MAX_CAPABILITY_ATTESTATION_CONFIG_BYTES,
  );
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new CapabilityAttestationFileError('attestation_file_invalid');
  }
}

export function parseCapabilitySnapshotTrustPolicyFile(
  source: string,
): CapabilitySnapshotTrustPolicy {
  return parseStrict(
    source,
    capabilitySnapshotTrustPolicySchema,
    'trust_policy_invalid',
  );
}

export function parseCapabilitySnapshotChallengeReceiptFile(
  source: string,
): CapabilitySnapshotChallengeReceipt {
  return parseStrict(
    source,
    capabilitySnapshotChallengeReceiptSchema,
    'challenge_invalid',
  );
}

export function parseCapabilitySnapshot(source: string): CapabilitySnapshot {
  const snapshot = parseStrict(
    source,
    capabilitySnapshotSchema,
    'snapshot_invalid',
  );
  if (!verifyCapabilitySnapshotDigest(snapshot)) {
    throw new CapabilityAttestationFileError('snapshot_digest_mismatch');
  }
  return snapshot;
}

export function parseRuntimeQualificationReport(
  source: string,
): RuntimeQualificationReport {
  const report = parseStrict(
    source,
    runtimeQualificationReportSchema,
    'qualification_report_invalid',
  );
  if (!verifyRuntimeQualificationReportDigest(report)) {
    throw new CapabilityAttestationFileError(
      'qualification_report_digest_mismatch',
    );
  }
  return report;
}

export async function loadCapabilitySnapshotTrustPolicy(
  path: string,
): Promise<CapabilitySnapshotTrustPolicy> {
  return parseCapabilitySnapshotTrustPolicyFile(await readBoundedUtf8(path));
}

export async function loadCapabilitySnapshotChallengeReceipt(
  path: string,
): Promise<CapabilitySnapshotChallengeReceipt> {
  return parseCapabilitySnapshotChallengeReceiptFile(
    await readBoundedUtf8(path),
  );
}

export async function loadCapabilitySnapshot(
  path: string,
): Promise<CapabilitySnapshot> {
  return parseCapabilitySnapshot(await readBoundedUtf8(path));
}

export async function loadRuntimeQualificationReport(
  path: string,
): Promise<RuntimeQualificationReport> {
  return parseRuntimeQualificationReport(await readBoundedUtf8(path));
}

/** Returns a copied, bounded byte sequence. Parsing happens in the verifier. */
export async function loadCapabilitySnapshotAttestationBundle(
  path: string,
): Promise<Uint8Array> {
  return readBoundedFile(path, MAX_SIGSTORE_BUNDLE_BYTES);
}

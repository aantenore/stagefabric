import { compareCodePointStrings, sha256Digest } from './canonical.js';
import {
  capabilitySnapshotContentSchema,
  capabilitySnapshotSchema,
  type CapabilitySnapshot,
  type CapabilitySnapshotContent,
} from './schema.js';

function normalizedSnapshotContent(
  content: CapabilitySnapshotContent,
): CapabilitySnapshotContent {
  return {
    apiVersion: content.apiVersion,
    kind: content.kind,
    observedAt: content.observedAt,
    expiresAt: content.expiresAt,
    targets: [...content.targets]
      .map((target) => ({
        targetId: target.targetId,
        healthy: target.healthy,
        capabilities: [...target.capabilities].sort(compareCodePointStrings),
        ...(target.observedAt === undefined
          ? {}
          : { observedAt: target.observedAt }),
        ...(target.expiresAt === undefined
          ? {}
          : { expiresAt: target.expiresAt }),
        ...(target.expectedP95Ms === undefined
          ? {}
          : { expectedP95Ms: target.expectedP95Ms }),
        ...(target.costMicros === undefined
          ? {}
          : { costMicros: target.costMicros }),
      }))
      .sort((left, right) =>
        compareCodePointStrings(left.targetId, right.targetId),
      ),
  };
}

export function computeCapabilitySnapshotDigest(
  input: unknown,
): `sha256:${string}` {
  const content = capabilitySnapshotContentSchema.parse(input);
  return sha256Digest(normalizedSnapshotContent(content));
}

export function sealCapabilitySnapshot(input: unknown): CapabilitySnapshot {
  const content = capabilitySnapshotContentSchema.parse(input);
  return capabilitySnapshotSchema.parse({
    ...content,
    digest: computeCapabilitySnapshotDigest(content),
  });
}

export function verifyCapabilitySnapshotDigest(
  snapshot: CapabilitySnapshot,
): boolean {
  const { digest, ...content } = snapshot;
  return digest === computeCapabilitySnapshotDigest(content);
}

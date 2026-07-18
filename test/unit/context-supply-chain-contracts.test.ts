import { describe, expect, it } from 'vitest';

import { sha256Digest } from '../../src/domain/canonical.js';
import {
  CONTEXT_CONTRACT_API_VERSION,
  assembleEvidenceContext,
  estimateContextTokens,
  sealContextArtifact,
  sealContextRequest,
  verifyContextArtifactDigest,
  verifyContextRequestDigest,
} from '../../src/domain/context-supply-chain.js';
import {
  createFrozenContextRequest,
  runFrozenContextSupplyChain,
} from '../../src/composition/context-supply-chain.js';

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

describe('Context Supply Chain contracts', () => {
  it('canonicalizes source, residency, and parent ordering into one request digest', () => {
    const first = createFrozenContextRequest();
    const { digest: _digest, ...content } = first;
    const second = sealContextRequest({
      ...content,
      residencies: [...content.residencies].reverse(),
      sources: [...content.sources].reverse(),
      provenance: {
        ...content.provenance,
        parentArtifactDigests: [
          sha256Digest('parent-b'),
          sha256Digest('parent-a'),
        ],
      },
    });
    const third = sealContextRequest({
      ...content,
      provenance: {
        ...content.provenance,
        parentArtifactDigests: [
          sha256Digest('parent-a'),
          sha256Digest('parent-b'),
        ],
      },
    });

    expect(second.digest).toBe(third.digest);
    expect(second.apiVersion).toBe(CONTEXT_CONTRACT_API_VERSION);
    expect(verifyContextRequestDigest(second)).toBe(true);
  });

  it('rejects stale sources and detects post-seal mutation', () => {
    const request = createFrozenContextRequest();
    const { digest: _digest, ...content } = request;
    expect(() =>
      sealContextRequest({
        ...content,
        sources: content.sources.map((source, index) =>
          index === 0
            ? {
                ...source,
                freshness: {
                  observedAt: source.freshness.observedAt,
                  expiresAt: content.requestedAt,
                },
              }
            : source,
        ),
      }),
    ).toThrow();

    expect(
      verifyContextRequestDigest({ ...request, query: `${request.query}!` }),
    ).toBe(false);
  });

  it('rejects non-canonical raw requests even with a recomputed digest', () => {
    const request = createFrozenContextRequest();
    const { digest: _digest, ...content } = request;
    const reorderedContent = {
      ...content,
      sources: [...content.sources].reverse(),
    };
    const reordered = {
      ...reorderedContent,
      digest: sha256Digest(reorderedContent),
    };

    expect(verifyContextRequestDigest(reordered)).toBe(false);
    expect(sealContextRequest(reorderedContent).digest).toBe(request.digest);
  });

  it('normalizes artifact evidence before ordinal assembly and verifies accounting', async () => {
    const { artifact } = await runFrozenContextSupplyChain();
    const { digest: _digest, ...content } = artifact;
    const evidence = [...content.evidence].reverse();
    const context = assembleEvidenceContext(evidence);
    const reorderedContent = {
      ...content,
      evidence,
      context,
      accounting: {
        ...content.accounting,
        contextTokens: estimateContextTokens(context),
        totalInputTokens:
          content.accounting.queryTokens + estimateContextTokens(context),
        contextBytes: bytes(context),
        totalInputBytes: content.accounting.queryBytes + bytes(context),
      },
    };
    const reordered = {
      ...reorderedContent,
      digest: sha256Digest(reorderedContent),
    };

    expect(verifyContextArtifactDigest(reordered)).toBe(false);
    expect(sealContextArtifact(reorderedContent).digest).toBe(artifact.digest);
    expect(
      artifact.context.startsWith(
        `[E1] ${artifact.evidence[0]!.evidenceLocator}`,
      ),
    ).toBe(true);

    const accountingTamper = {
      ...content,
      accounting: {
        ...content.accounting,
        contextBytes: content.accounting.contextBytes + 1,
        totalInputBytes: content.accounting.totalInputBytes + 1,
      },
    };
    expect(
      verifyContextArtifactDigest({
        ...accountingTamper,
        digest: sha256Digest(accountingTamper),
      }),
    ).toBe(false);
  });
});

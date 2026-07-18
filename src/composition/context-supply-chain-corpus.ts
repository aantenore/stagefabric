import { sha256Digest } from '../domain/canonical.js';
import type {
  ContextClassification,
  ContextEvidence,
  ContextSource,
} from '../domain/context-supply-chain.js';

export interface FrozenContextSection {
  readonly title: string;
  readonly evidenceLocator: string;
  readonly content: string;
}

export interface FrozenContextDocument {
  readonly id: string;
  readonly sourceLocator: string;
  readonly indexLocator: string;
  readonly classification: ContextClassification;
  readonly freshness: {
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly sections: readonly FrozenContextSection[];
}

const FRESHNESS = Object.freeze({
  observedAt: '2026-07-01T00:00:00.000Z',
  expiresAt: '2027-01-01T00:00:00.000Z',
});

export const FROZEN_CONTEXT_CORPUS: readonly FrozenContextDocument[] =
  Object.freeze([
    Object.freeze({
      id: 'edge-operations',
      sourceLocator: 'urn:stagefabric:corpus:edge-operations:v3',
      indexLocator: 'urn:stagefabric:corpus:edge-operations:v3:index',
      classification: 'public' as const,
      freshness: FRESHNESS,
      sections: Object.freeze([
        Object.freeze({
          title: 'Failover quorum',
          evidenceLocator:
            'urn:stagefabric:corpus:edge-operations:v3#failover-quorum',
          content:
            'An EU edge runtime may enter failover only after two consecutive unhealthy probes from distinct observers. The coordinator records both probe evidence digests and the selected standby target before switching traffic.',
        }),
        Object.freeze({
          title: 'Recovery stabilization',
          evidenceLocator:
            'urn:stagefabric:corpus:edge-operations:v3#recovery-stabilization',
          content:
            'Recovery requires three healthy observations over ninety seconds. A recovering primary remains a fallback until the stabilization window is complete.',
        }),
        Object.freeze({
          title: 'Capacity routing',
          evidenceLocator:
            'urn:stagefabric:corpus:edge-operations:v3#capacity-routing',
          content:
            'Capacity routing prefers the lowest measured queue depth, then the lower expected latency. Cost is used only as a final deterministic tie break.',
        }),
      ]),
    }),
    Object.freeze({
      id: 'privacy-policy',
      sourceLocator: 'urn:stagefabric:corpus:privacy-policy:v5',
      indexLocator: 'urn:stagefabric:corpus:privacy-policy:v5:index',
      classification: 'public' as const,
      freshness: FRESHNESS,
      sections: Object.freeze([
        Object.freeze({
          title: 'Telemetry release',
          evidenceLocator:
            'urn:stagefabric:corpus:privacy-policy:v5#telemetry-release',
          content:
            'Telemetry may leave the EU edge zone only when the exact assembled payload has an allowed egress proof and contains aggregate counters without user or prompt content. The released byte count must not exceed the request budget.',
        }),
        Object.freeze({
          title: 'Cloud prohibition',
          evidenceLocator:
            'urn:stagefabric:corpus:privacy-policy:v5#cloud-prohibition',
          content:
            'Cloud egress is forbidden when classification is internal or restricted, residency evidence is missing, the destination is absent from the compiled plan, or any source freshness window has expired.',
        }),
        Object.freeze({
          title: 'Local diagnostics',
          evidenceLocator:
            'urn:stagefabric:corpus:privacy-policy:v5#local-diagnostics',
          content:
            'Local diagnostic logs retain stable reason codes and target identifiers. Payloads, credentials, endpoint addresses, and raw provider errors are excluded.',
        }),
      ]),
    }),
    Object.freeze({
      id: 'release-standard',
      sourceLocator: 'urn:stagefabric:corpus:release-standard:v2',
      indexLocator: 'urn:stagefabric:corpus:release-standard:v2:index',
      classification: 'public' as const,
      freshness: FRESHNESS,
      sections: Object.freeze([
        Object.freeze({
          title: 'Required release evidence',
          evidenceLocator:
            'urn:stagefabric:corpus:release-standard:v2#required-evidence',
          content:
            'Before release, retain the context request digest, source and index digests, exact evidence locators, adapter identifier and version, execution plan digest, egress ledger digest, token and byte accounting, and the benchmark gate result.',
        }),
        Object.freeze({
          title: 'Canary promotion',
          evidenceLocator:
            'urn:stagefabric:corpus:release-standard:v2#canary-promotion',
          content:
            'A canary is promoted after the bounded observation window completes with no policy rejection and the rollback artifact remains available.',
        }),
        Object.freeze({
          title: 'Evidence retention',
          evidenceLocator:
            'urn:stagefabric:corpus:release-standard:v2#retention',
          content:
            'Content-free decision evidence is retained for thirty days. Raw retrieved passages follow the source system retention policy and are not copied into operational logs.',
        }),
      ]),
    }),
  ]);

export function frozenContextSources(): readonly ContextSource[] {
  return FROZEN_CONTEXT_CORPUS.map((document) => {
    const sourceDigest = sha256Digest(
      document.sections.map((section) => ({
        locator: section.evidenceLocator,
        content: section.content,
      })),
    );
    const indexDigest = sha256Digest(
      document.sections.map((section) => ({
        title: section.title,
        locator: section.evidenceLocator,
      })),
    );
    return {
      id: document.id,
      sourceLocator: document.sourceLocator,
      sourceDigest,
      indexLocator: document.indexLocator,
      indexDigest,
      classification: document.classification,
      freshness: document.freshness,
    };
  });
}

export function frozenContextEvidence(): readonly ContextEvidence[] {
  const sources = new Map(
    frozenContextSources().map((source) => [source.id, source]),
  );
  return FROZEN_CONTEXT_CORPUS.flatMap((document) => {
    const source = sources.get(document.id)!;
    return document.sections.map((section) => ({
      sourceId: source.id,
      sourceLocator: source.sourceLocator,
      evidenceLocator: section.evidenceLocator,
      sourceDigest: source.sourceDigest,
      indexDigest: source.indexDigest,
      content: section.content,
      contentDigest: sha256Digest(section.content),
      classification: source.classification,
      observedAt: source.freshness.observedAt,
    }));
  });
}

export const FROZEN_CONTEXT_QUESTION =
  'Which evidence must be retained before an EU edge failover may release telemetry, and when is cloud egress forbidden?';

export const FROZEN_EXPECTED_EVIDENCE_LOCATORS = Object.freeze([
  'urn:stagefabric:corpus:edge-operations:v3#failover-quorum',
  'urn:stagefabric:corpus:privacy-policy:v5#telemetry-release',
  'urn:stagefabric:corpus:privacy-policy:v5#cloud-prohibition',
  'urn:stagefabric:corpus:release-standard:v2#required-evidence',
]);

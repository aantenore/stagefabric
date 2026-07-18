import { z } from 'zod';

import {
  canonicalJson,
  compareCodePointStrings,
  sha256Digest,
} from './canonical.js';
import { sha256DigestSchema, timestampSchema } from './schema.js';

export const CONTEXT_CONTRACT_API_VERSION =
  'stagefabric.dev/context/v1alpha1' as const;
export const CONTEXT_TOKEN_ESTIMATOR = {
  id: 'utf8-bytes-div-4-ceil',
  version: '1',
} as const;

const identifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/)
  .max(128);
const residencySchema = z.string().trim().min(1).max(128);
const classificationSchema = z.enum(['public', 'internal', 'restricted']);
function validLocator(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\S+$/u.test(value) &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 32 && codePoint !== 127;
    })
  );
}
const locatorSchema = z.string().min(3).max(2_048).refine(validLocator);
const versionSchema = z.string().trim().min(1).max(128);

const adapterIdentitySchema = z
  .object({
    id: identifierSchema,
    version: versionSchema,
  })
  .strict();

const freshnessSchema = z
  .object({
    observedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((freshness, context) => {
    if (Date.parse(freshness.observedAt) >= Date.parse(freshness.expiresAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than observedAt',
      });
    }
  });

const contextSourceSchema = z
  .object({
    id: identifierSchema,
    sourceLocator: locatorSchema,
    sourceDigest: sha256DigestSchema,
    indexLocator: locatorSchema,
    indexDigest: sha256DigestSchema,
    classification: classificationSchema,
    freshness: freshnessSchema,
  })
  .strict();

const requestBudgetSchema = z
  .object({
    maxContextTokens: z.number().int().min(1).max(1_000_000),
    maxTotalInputTokens: z.number().int().min(1).max(2_000_000),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
    maxEgressBytes: z.number().int().min(0).max(1_000_000_000),
  })
  .strict()
  .superRefine((budget, context) => {
    if (budget.maxContextTokens >= budget.maxTotalInputTokens) {
      context.addIssue({
        code: 'custom',
        path: ['maxContextTokens'],
        message: 'context budget must leave room for the query',
      });
    }
  });

const requestProvenanceSchema = z
  .object({
    intentDigest: sha256DigestSchema,
    policyDigest: sha256DigestSchema,
    parentArtifactDigests: z.array(sha256DigestSchema).max(64),
  })
  .strict();

const contextRequestContentShape = {
  apiVersion: z.literal(CONTEXT_CONTRACT_API_VERSION),
  kind: z.literal('ContextRequest'),
  requestId: identifierSchema,
  requestedAt: timestampSchema,
  query: z.string().trim().min(1).max(65_536),
  classification: classificationSchema,
  residencies: z.array(residencySchema).min(1).max(16),
  sources: z.array(contextSourceSchema).min(1).max(64),
  adapter: adapterIdentitySchema,
  budget: requestBudgetSchema,
  provenance: requestProvenanceSchema,
} as const;

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const itemKey = key(value);
    if (seen.has(itemKey)) {
      context.addIssue({
        code: 'custom',
        path: [path, index],
        message: `duplicate value '${itemKey}'`,
      });
    }
    seen.add(itemKey);
  }
}

function validateContextRequest(
  request: {
    readonly requestedAt: string;
    readonly residencies: readonly string[];
    readonly sources: readonly {
      readonly id: string;
      readonly sourceLocator: string;
      readonly freshness: {
        readonly observedAt: string;
        readonly expiresAt: string;
      };
    }[];
  },
  context: z.RefinementCtx,
): void {
  uniqueBy(request.residencies, (value) => value, 'residencies', context);
  uniqueBy(request.sources, (value) => value.id, 'sources', context);
  uniqueBy(request.sources, (value) => value.sourceLocator, 'sources', context);
  const requestedAt = Date.parse(request.requestedAt);
  for (const [index, source] of request.sources.entries()) {
    if (
      Date.parse(source.freshness.observedAt) > requestedAt ||
      Date.parse(source.freshness.expiresAt) <= requestedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sources', index, 'freshness'],
        message: 'source is not fresh at requestedAt',
      });
    }
  }
}

export const contextRequestContentSchema = z
  .object(contextRequestContentShape)
  .strict()
  .superRefine(validateContextRequest);

export const contextRequestSchema = z
  .object({
    ...contextRequestContentShape,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine(validateContextRequest);

export const contextEvidenceSchema = z
  .object({
    sourceId: identifierSchema,
    sourceLocator: locatorSchema,
    evidenceLocator: locatorSchema,
    sourceDigest: sha256DigestSchema,
    indexDigest: sha256DigestSchema,
    content: z.string().min(1).max(1_000_000),
    contentDigest: sha256DigestSchema,
    classification: classificationSchema,
    observedAt: timestampSchema,
  })
  .strict();

const artifactAccountingSchema = z
  .object({
    tokenEstimator: z
      .object({
        id: z.literal(CONTEXT_TOKEN_ESTIMATOR.id),
        version: z.literal(CONTEXT_TOKEN_ESTIMATOR.version),
      })
      .strict(),
    queryTokens: z.number().int().min(1),
    contextTokens: z.number().int().min(1),
    totalInputTokens: z.number().int().min(1),
    queryBytes: z.number().int().min(1),
    contextBytes: z.number().int().min(1),
    totalInputBytes: z.number().int().min(1),
    logicalEgressBytes: z.number().int().min(0),
  })
  .strict()
  .superRefine((accounting, context) => {
    if (
      accounting.totalInputTokens !==
      accounting.queryTokens + accounting.contextTokens
    ) {
      context.addIssue({
        code: 'custom',
        path: ['totalInputTokens'],
        message: 'totalInputTokens must equal query plus context tokens',
      });
    }
    if (
      accounting.totalInputBytes !==
      accounting.queryBytes + accounting.contextBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['totalInputBytes'],
        message: 'totalInputBytes must equal query plus context bytes',
      });
    }
  });

const artifactProvenanceSchema = z
  .object({
    requestDigest: sha256DigestSchema,
    planDigest: sha256DigestSchema,
    egressDigest: sha256DigestSchema,
    stageIds: z.tuple([
      z.literal('classify'),
      z.literal('retrieve'),
      z.literal('assemble'),
    ]),
    parentArtifactDigests: z.array(sha256DigestSchema).max(64),
  })
  .strict();

const contextArtifactContentShape = {
  apiVersion: z.literal(CONTEXT_CONTRACT_API_VERSION),
  kind: z.literal('ContextArtifact'),
  artifactId: identifierSchema,
  requestId: identifierSchema,
  adapter: adapterIdentitySchema,
  classification: classificationSchema,
  freshness: freshnessSchema,
  evidence: z.array(contextEvidenceSchema).min(1).max(256),
  context: z.string().min(1).max(4_000_000),
  accounting: artifactAccountingSchema,
  provenance: artifactProvenanceSchema,
} as const;

function validateContextArtifact(
  artifact: {
    readonly freshness: {
      readonly observedAt: string;
      readonly expiresAt: string;
    };
    readonly evidence: readonly {
      readonly sourceId: string;
      readonly evidenceLocator: string;
      readonly content: string;
      readonly contentDigest: string;
      readonly observedAt: string;
    }[];
    readonly context: string;
    readonly accounting: {
      readonly contextTokens: number;
      readonly contextBytes: number;
    };
  },
  context: z.RefinementCtx,
): void {
  uniqueBy(
    artifact.evidence,
    (value) => value.evidenceLocator,
    'evidence',
    context,
  );
  if (artifact.context !== assembleEvidenceContext(artifact.evidence)) {
    context.addIssue({
      code: 'custom',
      path: ['context'],
      message: 'context does not match ordered evidence',
    });
  }
  if (
    artifact.accounting.contextBytes !== contextByteLength(artifact.context)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['accounting', 'contextBytes'],
      message: 'context byte accounting mismatch',
    });
  }
  if (
    artifact.accounting.contextTokens !==
    estimateContextTokens(artifact.context)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['accounting', 'contextTokens'],
      message: 'context token accounting mismatch',
    });
  }
  for (const [index, evidence] of artifact.evidence.entries()) {
    if (evidence.contentDigest !== sha256Digest(evidence.content)) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', index, 'contentDigest'],
        message: 'content digest mismatch',
      });
    }
    if (
      Date.parse(evidence.observedAt) >
        Date.parse(artifact.freshness.observedAt) ||
      Date.parse(evidence.observedAt) >=
        Date.parse(artifact.freshness.expiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', index, 'observedAt'],
        message: 'evidence falls outside artifact freshness',
      });
    }
  }
}

const contextArtifactContentBaseSchema = z
  .object(contextArtifactContentShape)
  .strict();

export const contextArtifactContentSchema =
  contextArtifactContentBaseSchema.superRefine(validateContextArtifact);

export const contextArtifactSchema = z
  .object({
    ...contextArtifactContentShape,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine(validateContextArtifact);

export const contextRetrievalResultSchema = z
  .object({
    adapter: adapterIdentitySchema,
    evidence: z.array(contextEvidenceSchema).min(1).max(256),
    logicalEgressBytes: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();

const runAccountingSchema = z
  .object({
    tokenEstimator: z
      .object({
        id: z.literal(CONTEXT_TOKEN_ESTIMATOR.id),
        version: z.literal(CONTEXT_TOKEN_ESTIMATOR.version),
      })
      .strict(),
    queryTokens: z.number().int().min(1),
    contextTokens: z.number().int().min(1),
    totalInputTokens: z.number().int().min(1),
    outputTokens: z.number().int().min(1),
    queryBytes: z.number().int().min(1),
    contextBytes: z.number().int().min(1),
    totalInputBytes: z.number().int().min(1),
    outputBytes: z.number().int().min(1),
    logicalEgressBytes: z.number().int().min(0),
  })
  .strict()
  .superRefine((accounting, context) => {
    if (
      accounting.totalInputTokens !==
        accounting.queryTokens + accounting.contextTokens ||
      accounting.totalInputBytes !==
        accounting.queryBytes + accounting.contextBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['totalInputTokens'],
        message: 'consolidated accounting mismatch',
      });
    }
  });

const contextRunReceiptContentShape = {
  apiVersion: z.literal(CONTEXT_CONTRACT_API_VERSION),
  kind: z.literal('ContextRunReceipt'),
  requestId: identifierSchema,
  requestDigest: sha256DigestSchema,
  artifactDigest: sha256DigestSchema,
  planDigest: sha256DigestSchema,
  egressDigest: sha256DigestSchema,
  accounting: runAccountingSchema,
} as const;

export const contextRunReceiptContentSchema = z
  .object(contextRunReceiptContentShape)
  .strict();

export const contextRunReceiptSchema = z
  .object({
    ...contextRunReceiptContentShape,
    digest: sha256DigestSchema,
  })
  .strict();

export type ContextRequestContent = z.input<typeof contextRequestContentSchema>;
export type ContextRequest = z.infer<typeof contextRequestSchema>;
export type ContextSource = z.infer<typeof contextSourceSchema>;
export type ContextArtifactContent = z.input<
  typeof contextArtifactContentSchema
>;
export type ContextArtifact = z.infer<typeof contextArtifactSchema>;
export type ContextEvidence = z.infer<typeof contextEvidenceSchema>;
export type ContextClassification = z.infer<typeof classificationSchema>;
export type ContextRetrievalResult = z.infer<
  typeof contextRetrievalResultSchema
>;
export type ContextRunReceiptContent = z.input<
  typeof contextRunReceiptContentSchema
>;
export type ContextRunReceipt = z.infer<typeof contextRunReceiptSchema>;

function contextByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function estimateContextTokens(value: string): number {
  return Math.max(1, Math.ceil(contextByteLength(value) / 4));
}

export function assembleEvidenceContext(
  evidence: readonly Pick<ContextEvidence, 'evidenceLocator' | 'content'>[],
): string {
  return evidence
    .map(
      (item, index) =>
        `[E${index + 1}] ${item.evidenceLocator}\n${item.content}`,
    )
    .join('\n\n');
}

function normalizeContextRequest(
  parsed: z.infer<typeof contextRequestContentSchema>,
) {
  return {
    ...parsed,
    residencies: [...parsed.residencies].sort(compareCodePointStrings),
    sources: [...parsed.sources].sort((left, right) =>
      compareCodePointStrings(left.id, right.id),
    ),
    provenance: {
      ...parsed.provenance,
      parentArtifactDigests: [...parsed.provenance.parentArtifactDigests].sort(
        compareCodePointStrings,
      ),
    },
  };
}

function normalizeContextArtifact(
  parsed: z.infer<typeof contextArtifactContentBaseSchema>,
) {
  const evidence = [...parsed.evidence].sort((left, right) =>
    compareCodePointStrings(left.evidenceLocator, right.evidenceLocator),
  );
  const context = assembleEvidenceContext(evidence);
  const contextBytes = contextByteLength(context);
  const contextTokens = estimateContextTokens(context);
  return {
    ...parsed,
    evidence,
    context,
    accounting: {
      ...parsed.accounting,
      contextTokens,
      totalInputTokens: parsed.accounting.queryTokens + contextTokens,
      contextBytes,
      totalInputBytes: parsed.accounting.queryBytes + contextBytes,
    },
    provenance: {
      ...parsed.provenance,
      parentArtifactDigests: [...parsed.provenance.parentArtifactDigests].sort(
        compareCodePointStrings,
      ),
    },
  };
}

export function sealContextRequest(
  content: ContextRequestContent,
): ContextRequest {
  const parsed = contextRequestContentSchema.parse(content);
  const normalized = normalizeContextRequest(parsed);
  return contextRequestSchema.parse({
    ...normalized,
    digest: sha256Digest(normalized),
  });
}

export function verifyContextRequestDigest(request: ContextRequest): boolean {
  const parsed = contextRequestSchema.safeParse(request);
  if (!parsed.success) return false;
  const { digest, ...content } = parsed.data;
  const normalized = normalizeContextRequest(content);
  return (
    canonicalJson(content) === canonicalJson(normalized) &&
    digest === sha256Digest(normalized)
  );
}

export function sealContextArtifact(
  content: ContextArtifactContent,
): ContextArtifact {
  const parsed = contextArtifactContentBaseSchema.parse(content);
  const normalized = normalizeContextArtifact(parsed);
  return contextArtifactSchema.parse({
    ...normalized,
    digest: sha256Digest(normalized),
  });
}

export function verifyContextArtifactDigest(
  artifact: ContextArtifact,
): boolean {
  const parsed = contextArtifactSchema.safeParse(artifact);
  if (!parsed.success) return false;
  const { digest, ...content } = parsed.data;
  const normalized = normalizeContextArtifact(content);
  return (
    canonicalJson(content) === canonicalJson(normalized) &&
    digest === sha256Digest(normalized)
  );
}

export function sealContextRunReceipt(
  content: ContextRunReceiptContent,
): ContextRunReceipt {
  const parsed = contextRunReceiptContentSchema.parse(content);
  return contextRunReceiptSchema.parse({
    ...parsed,
    digest: sha256Digest(parsed),
  });
}

export function verifyContextRunReceiptDigest(
  receipt: ContextRunReceipt,
): boolean {
  const parsed = contextRunReceiptSchema.safeParse(receipt);
  if (!parsed.success) return false;
  const { digest, ...content } = parsed.data;
  return digest === sha256Digest(content);
}

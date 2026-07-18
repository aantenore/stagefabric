import { InProcessStageAdapter } from '../adapters/in-process-stage-adapter.js';
import { StageAdapterRegistry } from '../adapters/stage-adapter-registry.js';
import { executePlan, type ExecutionResult } from '../application/executor.js';
import {
  planStageGraph,
  type ExecutionPlan,
  type PlanRequest,
} from '../application/planner.js';
import {
  canonicalJson,
  compareCodePointStrings,
  sha256Digest,
} from '../domain/canonical.js';
import {
  CONTEXT_CONTRACT_API_VERSION,
  CONTEXT_TOKEN_ESTIMATOR,
  assembleEvidenceContext,
  contextArtifactSchema,
  contextRequestSchema,
  contextRetrievalResultSchema,
  estimateContextTokens,
  sealContextArtifact,
  sealContextRequest,
  sealContextRunReceipt,
  verifyContextArtifactDigest,
  verifyContextRequestDigest,
  type ContextArtifact,
  type ContextClassification,
  type ContextEvidence,
  type ContextRequest,
  type ContextRequestContent,
  type ContextRetrievalResult,
  type ContextRunReceipt,
} from '../domain/context-supply-chain.js';
import { fabricSchema, stageGraphSchema } from '../domain/schema.js';
import { sealCapabilitySnapshot } from '../domain/snapshot.js';
import {
  StageAdapterError,
  type StageAdapter,
} from '../ports/stage-adapter.js';
import {
  FROZEN_CONTEXT_CORPUS,
  FROZEN_CONTEXT_QUESTION,
  frozenContextEvidence,
  frozenContextSources,
} from './context-supply-chain-corpus.js';

export const DETERMINISTIC_CONTEXT_ADAPTER_ID =
  'deterministic-context' as const;
export const DETERMINISTIC_CONTEXT_ADAPTER_VERSION = '1.0.0' as const;
export const CONTEXT_LOCAL_ADAPTER_KIND = 'context-local' as const;
export const FROZEN_CONTEXT_EVALUATED_AT = '2026-07-18T10:00:00.000Z';

const CONTEXT_REQUEST_TYPE =
  'application/vnd.stagefabric.context-request+json' as const;
const CONTEXT_RETRIEVAL_TYPE =
  'application/vnd.stagefabric.context-retrieval+json' as const;
const CONTEXT_ARTIFACT_TYPE =
  'application/vnd.stagefabric.context-artifact+json' as const;
const CONTEXT_ANSWER_TYPE =
  'application/vnd.stagefabric.context-answer+json' as const;

const CLASSIFICATION_RANK: Readonly<Record<ContextClassification, number>> = {
  public: 0,
  internal: 1,
  restricted: 2,
};

const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'from',
  'have',
  'into',
  'must',
  'only',
  'that',
  'their',
  'then',
  'when',
  'which',
  'with',
]);

export interface ContextReasoningResult {
  readonly answer: string;
  readonly citations: readonly string[];
  readonly accounting: {
    readonly outputTokens: number;
    readonly outputBytes: number;
  };
}

export interface ContextReasoner {
  reason(request: {
    readonly query: string;
    readonly artifact: ContextArtifact;
  }):
    | Omit<ContextReasoningResult, 'accounting'>
    | Promise<Omit<ContextReasoningResult, 'accounting'>>;
}

export interface ContextRetrievalPlacement {
  readonly adapter: StageAdapter;
  readonly targetId: string;
  readonly zone: string;
  readonly residencies: readonly string[];
  readonly trustLevel: number;
  readonly expectedP95Ms: number;
  readonly costMicros: number;
}

export interface RunContextSupplyChainOptions {
  readonly request: ContextRequest;
  /** Omit to use the credential-free frozen in-process baseline. */
  readonly retrieval?: ContextRetrievalPlacement;
  readonly reasoner?: ContextReasoner;
  /** Explicit deterministic evaluation instant; mutually exclusive with clock. */
  readonly evaluatedAt?: string;
  readonly clock?: { readonly now: () => Date };
  readonly maxFutureSkewMs?: number;
}

export interface ContextSupplyChainRun {
  readonly plan: ExecutionPlan;
  readonly execution: ExecutionResult;
  readonly artifact: ContextArtifact;
  readonly reasoning: ContextReasoningResult;
  readonly receipt: ContextRunReceipt;
  readonly egressLedger: ExecutionPlan['egress'];
}

export type ContextSupplyChainErrorCode =
  | 'context_request_digest_mismatch'
  | 'context_evaluated_at_invalid'
  | 'context_request_from_future'
  | 'context_source_not_fresh';

export class ContextSupplyChainError extends Error {
  readonly code: ContextSupplyChainErrorCode;

  constructor(code: ContextSupplyChainErrorCode) {
    super(code);
    this.name = 'ContextSupplyChainError';
    this.code = code;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function terms(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .match(/[a-z0-9]+/gu)
        ?.filter((term) => term.length >= 4 && !STOP_WORDS.has(term)) ?? [],
    ),
  ].sort(compareCodePointStrings);
}

function scoreEvidence(
  queryTerms: readonly string[],
  evidence: ContextEvidence,
): number {
  const haystack = ` ${evidence.content.toLocaleLowerCase('en-US')} `;
  return queryTerms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
}

function exactFrozenSources(request: ContextRequest): boolean {
  const expected = frozenContextSources();
  return canonicalJson(request.sources) === canonicalJson(expected);
}

function deterministicRetrieve(
  request: ContextRequest,
): ContextRetrievalResult {
  if (
    request.adapter.id !== DETERMINISTIC_CONTEXT_ADAPTER_ID ||
    request.adapter.version !== DETERMINISTIC_CONTEXT_ADAPTER_VERSION ||
    !exactFrozenSources(request)
  ) {
    throw new StageAdapterError({ code: 'adapter_failure' });
  }
  const queryTerms = terms(request.query);
  const ranked = frozenContextEvidence()
    .map((evidence) => ({
      evidence,
      score: scoreEvidence(queryTerms, evidence),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodePointStrings(
          left.evidence.evidenceLocator,
          right.evidence.evidenceLocator,
        ),
    );

  const selected: ContextEvidence[] = [];
  let tokens = 0;
  const minimumScore = Math.max(2, (ranked[0]?.score ?? 0) - 1);
  for (const candidate of ranked) {
    if (candidate.score < minimumScore) continue;
    const nextTokens = estimateContextTokens(candidate.evidence.content);
    if (tokens + nextTokens > request.budget.maxContextTokens) continue;
    selected.push(candidate.evidence);
    tokens += nextTokens;
    if (selected.length === 8) break;
  }
  if (selected.length < 1) {
    throw new StageAdapterError({ code: 'adapter_failure' });
  }
  return contextRetrievalResultSchema.parse({
    adapter: request.adapter,
    evidence: selected,
    logicalEgressBytes: 0,
  });
}

function effectiveClassification(
  request: ContextRequest,
): ContextClassification {
  return [
    request.classification,
    ...request.sources.map((source) => source.classification),
  ].sort(
    (left, right) => CLASSIFICATION_RANK[right] - CLASSIFICATION_RANK[left],
  )[0]!;
}

function createPlanRequest(
  request: ContextRequest,
  retrieval: ContextRetrievalPlacement | undefined,
  evaluatedAt: string,
): PlanRequest {
  const classification = effectiveClassification(request);
  const localCapabilities = [
    'context.validate-classification',
    'context.assemble',
    'context.reason',
    ...(retrieval === undefined ? ['context.retrieve'] : []),
  ];
  const localTarget = {
    id: 'context-local-runtime',
    zone: 'context-local',
    adapter: { kind: CONTEXT_LOCAL_ADAPTER_KIND },
    capabilities: localCapabilities,
    expectedP95Ms: 1,
    costMicros: 0,
  };
  const zones = [
    {
      id: 'context-local',
      trustLevel: 3,
      residencies: request.residencies,
    },
    ...(retrieval === undefined
      ? []
      : [
          {
            id: retrieval.zone,
            trustLevel: retrieval.trustLevel,
            residencies: [...retrieval.residencies],
          },
        ]),
  ];
  const targets = [
    localTarget,
    ...(retrieval === undefined
      ? []
      : [
          {
            id: retrieval.targetId,
            zone: retrieval.zone,
            adapter: { kind: retrieval.adapter.kind },
            capabilities: ['context.retrieve'],
            expectedP95Ms: retrieval.expectedP95Ms,
            costMicros: retrieval.costMicros,
          },
        ]),
  ];
  const fabric = fabricSchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'Fabric',
    zones,
    classifications: [
      { id: 'public', rank: 0, minTrustLevel: 0 },
      {
        id: 'internal',
        rank: 1,
        minTrustLevel: 2,
        allowedZones: ['context-local'],
      },
      {
        id: 'restricted',
        rank: 2,
        minTrustLevel: 3,
        allowedZones: ['context-local'],
      },
    ],
    targets,
    policy: {
      zonePreference: [
        'context-local',
        ...(retrieval === undefined ? [] : [retrieval.zone]),
      ],
      maxFallbacks: 0,
    },
  });
  const snapshot = sealCapabilitySnapshot({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshot',
    observedAt: evaluatedAt,
    expiresAt: minimumTimestamp(
      request.sources.map((source) => source.freshness.expiresAt),
    ),
    targets: targets.map((target) => ({
      targetId: target.id,
      healthy: true,
      capabilities: target.capabilities,
    })),
  });
  const retrievalZone = retrieval?.zone ?? 'context-local';
  const graph = stageGraphSchema.parse({
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'StageGraph',
    metadata: { name: 'context-supply-chain' },
    inputs: [
      {
        name: 'request',
        type: CONTEXT_REQUEST_TYPE,
        classification,
        residencies: request.residencies,
        origin: { zone: 'context-local', targetId: localTarget.id },
      },
    ],
    stages: [
      {
        id: 'classify',
        operation: 'context.validate-classification',
        inputs: {
          request: { ref: 'input.request', type: CONTEXT_REQUEST_TYPE },
        },
        outputs: [
          {
            name: 'classified',
            type: CONTEXT_REQUEST_TYPE,
            classification,
          },
        ],
        requirements: {
          capabilities: ['context.validate-classification'],
          allowedZones: ['context-local'],
        },
      },
      {
        id: 'retrieve',
        operation: 'context.retrieve',
        inputs: {
          request: { ref: 'classify.classified', type: CONTEXT_REQUEST_TYPE },
        },
        outputs: [
          {
            name: 'retrieval',
            type: CONTEXT_RETRIEVAL_TYPE,
            classification,
          },
        ],
        requirements: {
          capabilities: ['context.retrieve'],
          allowedZones: [retrievalZone],
        },
      },
      {
        id: 'assemble',
        operation: 'context.assemble',
        inputs: {
          request: { ref: 'classify.classified', type: CONTEXT_REQUEST_TYPE },
          retrieval: {
            ref: 'retrieve.retrieval',
            type: CONTEXT_RETRIEVAL_TYPE,
          },
        },
        outputs: [
          {
            name: 'artifact',
            type: CONTEXT_ARTIFACT_TYPE,
            classification,
          },
        ],
        requirements: {
          capabilities: ['context.assemble'],
          allowedZones: ['context-local'],
        },
      },
      {
        id: 'reason',
        operation: 'context.reason',
        inputs: {
          request: { ref: 'classify.classified', type: CONTEXT_REQUEST_TYPE },
          artifact: { ref: 'assemble.artifact', type: CONTEXT_ARTIFACT_TYPE },
        },
        outputs: [
          {
            name: 'result',
            type: CONTEXT_ANSWER_TYPE,
            classification,
          },
        ],
        requirements: {
          capabilities: ['context.reason'],
          allowedZones: ['context-local'],
        },
      },
    ],
  });
  return { fabric, snapshot, graph, evaluatedAt };
}

function minimumTimestamp(values: readonly string[]): string {
  return new Date(
    Math.min(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

function resolveEvaluation(
  request: ContextRequest,
  options: Pick<
    RunContextSupplyChainOptions,
    'evaluatedAt' | 'clock' | 'maxFutureSkewMs'
  >,
): string {
  if (options.evaluatedAt !== undefined && options.clock !== undefined) {
    throw new ContextSupplyChainError('context_evaluated_at_invalid');
  }
  const clockValue =
    options.evaluatedAt === undefined
      ? (options.clock?.now() ?? new Date())
      : undefined;
  const evaluatedEpoch =
    options.evaluatedAt === undefined
      ? clockValue instanceof Date
        ? clockValue.getTime()
        : Number.NaN
      : Date.parse(options.evaluatedAt);
  const skew = options.maxFutureSkewMs ?? 5_000;
  if (
    !Number.isSafeInteger(skew) ||
    skew < 0 ||
    skew > 300_000 ||
    !Number.isFinite(evaluatedEpoch)
  ) {
    throw new ContextSupplyChainError('context_evaluated_at_invalid');
  }
  if (Date.parse(request.requestedAt) > evaluatedEpoch + skew) {
    throw new ContextSupplyChainError('context_request_from_future');
  }
  if (
    request.sources.some(
      (source) =>
        Date.parse(source.freshness.observedAt) > evaluatedEpoch ||
        Date.parse(source.freshness.expiresAt) <= evaluatedEpoch,
    )
  ) {
    throw new ContextSupplyChainError('context_source_not_fresh');
  }
  return new Date(evaluatedEpoch).toISOString();
}

function requireRequest(
  value: unknown,
  expectedDigest: string,
): ContextRequest {
  const parsed = contextRequestSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.digest !== expectedDigest ||
    !verifyContextRequestDigest(parsed.data)
  ) {
    throw new StageAdapterError({ code: 'adapter_failure' });
  }
  return parsed.data;
}

function requireEvidenceMatchesRequest(
  request: ContextRequest,
  retrieval: ContextRetrievalResult,
): void {
  if (
    retrieval.adapter.id !== request.adapter.id ||
    retrieval.adapter.version !== request.adapter.version ||
    retrieval.logicalEgressBytes > request.budget.maxEgressBytes
  ) {
    throw new StageAdapterError({ code: 'adapter_failure' });
  }
  const sources = new Map(request.sources.map((source) => [source.id, source]));
  for (const evidence of retrieval.evidence) {
    const source = sources.get(evidence.sourceId);
    if (
      source === undefined ||
      evidence.sourceLocator !== source.sourceLocator ||
      evidence.sourceDigest !== source.sourceDigest ||
      evidence.indexDigest !== source.indexDigest ||
      evidence.classification !== source.classification ||
      evidence.observedAt !== source.freshness.observedAt ||
      evidence.contentDigest !== sha256Digest(evidence.content)
    ) {
      throw new StageAdapterError({ code: 'adapter_failure' });
    }
  }
}

function assembleArtifact(
  request: ContextRequest,
  retrieval: ContextRetrievalResult,
  plan: ExecutionPlan,
  evaluatedAt: string,
): ContextArtifact {
  requireEvidenceMatchesRequest(request, retrieval);
  const orderedEvidence = [...retrieval.evidence].sort((left, right) =>
    compareCodePointStrings(left.evidenceLocator, right.evidenceLocator),
  );
  const context = assembleEvidenceContext(orderedEvidence);
  const queryTokens = estimateContextTokens(request.query);
  const contextTokens = estimateContextTokens(context);
  if (
    contextTokens > request.budget.maxContextTokens ||
    queryTokens + contextTokens > request.budget.maxTotalInputTokens
  ) {
    throw new StageAdapterError({ code: 'adapter_failure' });
  }
  return sealContextArtifact({
    apiVersion: CONTEXT_CONTRACT_API_VERSION,
    kind: 'ContextArtifact',
    artifactId: `${request.requestId}-context`,
    requestId: request.requestId,
    adapter: request.adapter,
    classification: effectiveClassification(request),
    freshness: {
      observedAt: evaluatedAt,
      expiresAt: minimumTimestamp(
        request.sources.map((source) => source.freshness.expiresAt),
      ),
    },
    evidence: orderedEvidence,
    context,
    accounting: {
      tokenEstimator: CONTEXT_TOKEN_ESTIMATOR,
      queryTokens,
      contextTokens,
      totalInputTokens: queryTokens + contextTokens,
      queryBytes: utf8Bytes(request.query),
      contextBytes: utf8Bytes(context),
      totalInputBytes: utf8Bytes(request.query) + utf8Bytes(context),
      logicalEgressBytes: retrieval.logicalEgressBytes,
    },
    provenance: {
      requestDigest: request.digest,
      planDigest: plan.digest,
      egressDigest: plan.egress.digest,
      stageIds: ['classify', 'retrieve', 'assemble'],
      parentArtifactDigests: request.provenance.parentArtifactDigests,
    },
  });
}

const defaultReasoner: ContextReasoner = {
  reason: ({ artifact }) => ({
    answer: artifact.evidence.map((evidence) => evidence.content).join(' '),
    citations: artifact.evidence.map((evidence) => evidence.evidenceLocator),
  }),
};

export function createFrozenContextRequest(
  adapter: { readonly id: string; readonly version: string } = {
    id: DETERMINISTIC_CONTEXT_ADAPTER_ID,
    version: DETERMINISTIC_CONTEXT_ADAPTER_VERSION,
  },
  options: {
    readonly requestId?: string;
    readonly query?: string;
    readonly classification?: ContextClassification;
    readonly maxContextTokens?: number;
  } = {},
): ContextRequest {
  const sources = frozenContextSources();
  const query = options.query ?? FROZEN_CONTEXT_QUESTION;
  const content: ContextRequestContent = {
    apiVersion: CONTEXT_CONTRACT_API_VERSION,
    kind: 'ContextRequest',
    requestId: options.requestId ?? 'eu-edge-release',
    requestedAt: '2026-07-18T10:00:00.000Z',
    query,
    classification: options.classification ?? 'public',
    residencies: ['EU'],
    sources: [...sources],
    adapter,
    budget: {
      maxContextTokens: options.maxContextTokens ?? 320,
      maxTotalInputTokens: (options.maxContextTokens ?? 320) + 128,
      maxOutputTokens: 320,
      maxEgressBytes: 64_000,
    },
    provenance: {
      intentDigest: sha256Digest({ query }),
      policyDigest: sha256Digest({
        policy: 'frozen-context-supply-chain-v1',
      }),
      parentArtifactDigests: [],
    },
  };
  return sealContextRequest(content);
}

export async function runContextSupplyChain(
  options: RunContextSupplyChainOptions,
): Promise<ContextSupplyChainRun> {
  const request = contextRequestSchema.parse(options.request);
  if (!verifyContextRequestDigest(request)) {
    throw new ContextSupplyChainError('context_request_digest_mismatch');
  }
  const evaluatedAt = resolveEvaluation(request, options);
  if (
    options.retrieval !== undefined &&
    (options.retrieval.adapter.kind === CONTEXT_LOCAL_ADAPTER_KIND ||
      options.retrieval.zone === 'context-local' ||
      options.retrieval.targetId === 'context-local-runtime')
  ) {
    throw new TypeError('context_retrieval_placement_invalid');
  }
  const plan = planStageGraph(
    createPlanRequest(request, options.retrieval, evaluatedAt),
  );
  const reasoner = options.reasoner ?? defaultReasoner;
  const localAdapter = new InProcessStageAdapter(CONTEXT_LOCAL_ADAPTER_KIND, {
    'context.validate-classification': ({ inputs }) => ({
      outputs: { classified: requireRequest(inputs.request, request.digest) },
    }),
    ...(options.retrieval === undefined
      ? {
          'context.retrieve': ({
            inputs,
          }: {
            inputs: Readonly<Record<string, unknown>>;
          }) => ({
            outputs: {
              retrieval: deterministicRetrieve(
                requireRequest(inputs.request, request.digest),
              ),
            },
          }),
        }
      : {}),
    'context.assemble': ({ inputs }) => {
      const exactRequest = requireRequest(inputs.request, request.digest);
      const retrieval = contextRetrievalResultSchema.parse(inputs.retrieval);
      return {
        outputs: {
          artifact: assembleArtifact(
            exactRequest,
            retrieval,
            plan,
            evaluatedAt,
          ),
        },
      };
    },
    'context.reason': async ({ inputs }) => {
      const exactRequest = requireRequest(inputs.request, request.digest);
      const artifact = contextArtifactSchema.parse(inputs.artifact);
      if (
        !verifyContextArtifactDigest(artifact) ||
        artifact.provenance.requestDigest !== exactRequest.digest ||
        artifact.provenance.planDigest !== plan.digest ||
        artifact.provenance.egressDigest !== plan.egress.digest
      ) {
        throw new StageAdapterError({ code: 'adapter_failure' });
      }
      const reasoned = await reasoner.reason({
        query: exactRequest.query,
        artifact,
      });
      if (
        typeof reasoned.answer !== 'string' ||
        reasoned.answer.trim().length < 1 ||
        reasoned.answer.length > 1_000_000 ||
        !Array.isArray(reasoned.citations) ||
        new Set(reasoned.citations).size !== reasoned.citations.length
      ) {
        throw new StageAdapterError({ code: 'adapter_failure' });
      }
      const locators = new Set(
        artifact.evidence.map((evidence) => evidence.evidenceLocator),
      );
      if (reasoned.citations.some((citation) => !locators.has(citation))) {
        throw new StageAdapterError({ code: 'adapter_failure' });
      }
      const outputTokens = estimateContextTokens(reasoned.answer);
      if (outputTokens > exactRequest.budget.maxOutputTokens) {
        throw new StageAdapterError({ code: 'adapter_failure' });
      }
      return {
        outputs: {
          result: {
            answer: reasoned.answer,
            citations: [...reasoned.citations],
            accounting: {
              outputTokens,
              outputBytes: utf8Bytes(reasoned.answer),
            },
          } satisfies ContextReasoningResult,
        },
      };
    },
  });
  const registry = new StageAdapterRegistry([
    localAdapter,
    ...(options.retrieval === undefined ? [] : [options.retrieval.adapter]),
  ]);
  const execution = await executePlan({
    plan,
    inputs: { request },
    adapters: registry,
  });
  const artifact = contextArtifactSchema.parse(
    execution.values['assemble.artifact'],
  );
  const reasoning = execution.values['reason.result'] as ContextReasoningResult;
  if (!verifyContextArtifactDigest(artifact)) {
    throw new Error('context_artifact_digest_mismatch');
  }
  const receipt = sealContextRunReceipt({
    apiVersion: CONTEXT_CONTRACT_API_VERSION,
    kind: 'ContextRunReceipt',
    requestId: request.requestId,
    requestDigest: request.digest,
    artifactDigest: artifact.digest,
    planDigest: plan.digest,
    egressDigest: plan.egress.digest,
    accounting: {
      ...artifact.accounting,
      outputTokens: reasoning.accounting.outputTokens,
      outputBytes: reasoning.accounting.outputBytes,
    },
  });
  return {
    plan,
    execution,
    artifact,
    reasoning,
    receipt,
    egressLedger: plan.egress,
  };
}

export async function runFrozenContextSupplyChain(): Promise<ContextSupplyChainRun> {
  return runContextSupplyChain({
    request: createFrozenContextRequest(),
    evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
  });
}

export const FROZEN_CONTEXT_DOCUMENT_COUNT = FROZEN_CONTEXT_CORPUS.length;

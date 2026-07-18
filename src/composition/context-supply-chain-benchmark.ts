import { performance } from 'node:perf_hooks';

import {
  PAGEINDEX_CONTEXT_ADAPTER_ID,
  PAGEINDEX_CONTEXT_ADAPTER_VERSION,
  PageIndexContextStageAdapter,
} from '../adapters/pageindex-context-stage-adapter.js';
import { isExecutionError } from '../application/executor.js';
import { PlannerError } from '../application/planner.js';
import {
  canonicalJson,
  compareCodePointStrings,
  sha256Digest,
} from '../domain/canonical.js';
import {
  assembleEvidenceContext,
  contextRetrievalResultSchema,
  estimateContextTokens,
  sealContextRequest,
  type ContextEvidence,
  type ContextRequest,
} from '../domain/context-supply-chain.js';
import type {
  StageAdapter,
  StageAdapterRequest,
} from '../ports/stage-adapter.js';
import {
  ContextSupplyChainError,
  FROZEN_CONTEXT_EVALUATED_AT,
  createFrozenContextRequest,
  runContextSupplyChain,
} from './context-supply-chain.js';
import { frozenContextEvidence } from './context-supply-chain-corpus.js';

export interface CorpusFact {
  readonly id: string;
  readonly evidenceLocator: string;
  readonly supportText: string;
  readonly supportDigest: string;
}

export interface ContextBenchmarkCase {
  readonly id: string;
  readonly query: string;
  readonly requiredFactIds: readonly string[];
  readonly forbiddenFactIds: readonly string[];
  readonly maxContextTokens: number;
}

export interface ContextCaseMetrics {
  readonly evidenceRecall: number;
  readonly evidencePrecision: number;
  readonly factRecall: number;
  readonly factPrecision: number;
  readonly answerSupportSufficient: boolean;
  readonly inputTokens: number;
  readonly inputBytes: number;
  readonly selectedEvidenceCount: number;
  readonly logicalEgressBytes: number;
}

export interface ContextAggregateMetrics {
  readonly macroEvidenceRecall: number;
  readonly macroEvidencePrecision: number;
  readonly macroFactRecall: number;
  readonly macroFactPrecision: number;
  readonly sufficiencyRate: number;
  readonly meanInputTokens: number;
  readonly p95InputTokens: number;
  readonly totalInputBytes: number;
  readonly logicalEgressBytes: number;
}

export interface ContextSupplyChainBenchmarkReport {
  readonly corpus: {
    readonly id: 'stagefabric-context-corpus-v2';
    readonly factManifestDigest: string;
    readonly caseManifestDigest: string;
  };
  readonly cases: readonly {
    readonly id: string;
    readonly candidate: ContextCaseMetrics;
    readonly simpleChunk: ContextCaseMetrics;
    readonly fullContext: ContextCaseMetrics;
    readonly planDigest: string;
  }[];
  readonly methods: {
    readonly contextSupplyChain: ContextAggregateMetrics;
    readonly simpleChunk: ContextAggregateMetrics;
    readonly fullContext: ContextAggregateMetrics;
  };
  readonly measuredLatencyMs: {
    readonly contextSupplyChain: number;
    readonly simpleChunk: number;
    readonly fullContext: number;
  };
  readonly safety: {
    readonly localHasNoBoundaryProofs: boolean;
    readonly publicBoundaryProofsExact: boolean;
    readonly restrictedExternalDeniedBeforeIo: boolean;
    readonly residencyMismatchDeniedBeforeIo: boolean;
    readonly expiredRequestDeniedBeforeIo: boolean;
    readonly tamperedRequestDeniedBeforeIo: boolean;
    readonly requestOverBudgetDeniedBeforePageIndexIo: boolean;
    readonly evidenceOverBudgetDeniedBeforeArtifact: boolean;
    readonly passed: boolean;
  };
  readonly reproducibility: {
    readonly planDigestsReproducible: boolean;
    readonly reportDigestReproducible: boolean;
  };
  readonly killGate: {
    readonly safetyPassed: boolean;
    readonly qualityAtLeastSimpleChunk: boolean;
    readonly sameBaselinePareto: boolean;
    readonly contextReducedAgainstFull: boolean;
    readonly reproducible: boolean;
    readonly passed: boolean;
  };
  readonly digest: string;
}

const FACT_DEFINITIONS = [
  [
    'failover-probes',
    'urn:stagefabric:corpus:edge-operations:v3#failover-quorum',
    'two consecutive unhealthy probes from distinct observers',
  ],
  [
    'failover-record',
    'urn:stagefabric:corpus:edge-operations:v3#failover-quorum',
    'records both probe evidence digests and the selected standby target',
  ],
  [
    'recovery-observations',
    'urn:stagefabric:corpus:edge-operations:v3#recovery-stabilization',
    'three healthy observations over ninety seconds',
  ],
  [
    'recovery-fallback',
    'urn:stagefabric:corpus:edge-operations:v3#recovery-stabilization',
    'remains a fallback until the stabilization window is complete',
  ],
  [
    'capacity-order',
    'urn:stagefabric:corpus:edge-operations:v3#capacity-routing',
    'prefers the lowest measured queue depth, then the lower expected latency',
  ],
  [
    'capacity-cost',
    'urn:stagefabric:corpus:edge-operations:v3#capacity-routing',
    'Cost is used only as a final deterministic tie break',
  ],
  [
    'telemetry-proof',
    'urn:stagefabric:corpus:privacy-policy:v5#telemetry-release',
    'only when the exact assembled payload has an allowed egress proof',
  ],
  [
    'telemetry-content',
    'urn:stagefabric:corpus:privacy-policy:v5#telemetry-release',
    'aggregate counters without user or prompt content',
  ],
  [
    'telemetry-budget',
    'urn:stagefabric:corpus:privacy-policy:v5#telemetry-release',
    'released byte count must not exceed the request budget',
  ],
  [
    'cloud-classification',
    'urn:stagefabric:corpus:privacy-policy:v5#cloud-prohibition',
    'Cloud egress is forbidden when classification is internal or restricted',
  ],
  [
    'cloud-evidence',
    'urn:stagefabric:corpus:privacy-policy:v5#cloud-prohibition',
    'residency evidence is missing, the destination is absent from the compiled plan, or any source freshness window has expired',
  ],
  [
    'diagnostic-exclusions',
    'urn:stagefabric:corpus:privacy-policy:v5#local-diagnostics',
    'Payloads, credentials, endpoint addresses, and raw provider errors are excluded',
  ],
  [
    'release-lineage',
    'urn:stagefabric:corpus:release-standard:v2#required-evidence',
    'retain the context request digest, source and index digests, exact evidence locators, adapter identifier and version, execution plan digest, egress ledger digest, token and byte accounting, and the benchmark gate result',
  ],
  [
    'canary-promotion',
    'urn:stagefabric:corpus:release-standard:v2#canary-promotion',
    'promoted after the bounded observation window completes with no policy rejection and the rollback artifact remains available',
  ],
  [
    'retention-duration',
    'urn:stagefabric:corpus:release-standard:v2#retention',
    'Content-free decision evidence is retained for thirty days',
  ],
  [
    'retention-source-policy',
    'urn:stagefabric:corpus:release-standard:v2#retention',
    'Raw retrieved passages follow the source system retention policy',
  ],
] as const;

export const CONTEXT_BENCHMARK_FACTS: readonly CorpusFact[] = Object.freeze(
  FACT_DEFINITIONS.map(([id, evidenceLocator, supportText]) =>
    Object.freeze({
      id,
      evidenceLocator,
      supportText,
      supportDigest: sha256Digest(supportText),
    }),
  ),
);

export const CONTEXT_BENCHMARK_CASES: readonly ContextBenchmarkCase[] =
  Object.freeze([
    {
      id: 'failover-gate',
      query:
        'What observations and records are required before switching edge traffic?',
      requiredFactIds: ['failover-probes', 'failover-record'],
      forbiddenFactIds: [],
      maxContextTokens: 160,
    },
    {
      id: 'recovery-counterfactual',
      query: 'Can one healthy observation restore the recovering primary?',
      requiredFactIds: ['recovery-observations', 'recovery-fallback'],
      forbiddenFactIds: ['failover-probes'],
      maxContextTokens: 160,
    },
    {
      id: 'capacity-tiebreak',
      query:
        'After queue depth, what latency and cost order selects a capacity target?',
      requiredFactIds: ['capacity-order', 'capacity-cost'],
      forbiddenFactIds: [],
      maxContextTokens: 160,
    },
    {
      id: 'telemetry-release',
      query:
        'What exact proof, content, and byte conditions allow EU edge telemetry release?',
      requiredFactIds: [
        'telemetry-proof',
        'telemetry-content',
        'telemetry-budget',
      ],
      forbiddenFactIds: [],
      maxContextTokens: 160,
    },
    {
      id: 'cloud-residency-trap',
      query:
        'Does residency alone permit internal data in cloud, and what evidence can deny it?',
      requiredFactIds: ['cloud-classification', 'cloud-evidence'],
      forbiddenFactIds: [],
      maxContextTokens: 160,
    },
    {
      id: 'diagnostic-exclusions',
      query: 'What content must local diagnostic logs exclude?',
      requiredFactIds: ['diagnostic-exclusions'],
      forbiddenFactIds: [],
      maxContextTokens: 120,
    },
    {
      id: 'release-lineage',
      query:
        'Which lineage and accounting evidence must be retained before release?',
      requiredFactIds: ['release-lineage'],
      forbiddenFactIds: [],
      maxContextTokens: 180,
    },
    {
      id: 'canary-promotion',
      query:
        'When may a canary be promoted and what rollback condition remains?',
      requiredFactIds: ['canary-promotion'],
      forbiddenFactIds: [],
      maxContextTokens: 120,
    },
    {
      id: 'evidence-retention',
      query:
        'How long is decision evidence retained and what governs raw passages?',
      requiredFactIds: ['retention-duration', 'retention-source-policy'],
      forbiddenFactIds: ['release-lineage'],
      maxContextTokens: 140,
    },
    {
      id: 'multi-hop-release',
      query:
        'Which evidence must be retained before an EU edge failover may release telemetry, and when is cloud egress forbidden?',
      requiredFactIds: [
        'failover-probes',
        'failover-record',
        'telemetry-proof',
        'telemetry-content',
        'telemetry-budget',
        'cloud-classification',
        'cloud-evidence',
        'release-lineage',
      ],
      forbiddenFactIds: [],
      maxContextTokens: 320,
    },
  ]);

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
        ?.filter((term) => term.length >= 4) ?? [],
    ),
  ];
}

function expectedLocators(testCase: ContextBenchmarkCase): Set<string> {
  const required = new Set(testCase.requiredFactIds);
  return new Set(
    CONTEXT_BENCHMARK_FACTS.filter((fact) => required.has(fact.id)).map(
      (fact) => fact.evidenceLocator,
    ),
  );
}

function scoreContext(
  testCase: ContextBenchmarkCase,
  selected: readonly Pick<ContextEvidence, 'evidenceLocator' | 'content'>[],
  query: string,
  logicalEgressBytes: number,
): ContextCaseMetrics {
  const context = assembleEvidenceContext(selected);
  const selectedLocators = new Set(
    selected.map((evidence) => evidence.evidenceLocator),
  );
  const requiredIds = new Set(testCase.requiredFactIds);
  const forbiddenIds = new Set(testCase.forbiddenFactIds);
  const factsPresent = CONTEXT_BENCHMARK_FACTS.filter(
    (fact) =>
      context.includes(fact.supportText) &&
      fact.supportDigest === sha256Digest(fact.supportText),
  );
  const presentIds = new Set(factsPresent.map((fact) => fact.id));
  const requiredPresent = testCase.requiredFactIds.filter((id) =>
    presentIds.has(id),
  ).length;
  const expected = expectedLocators(testCase);
  const expectedPresent = [...expected].filter((locator) =>
    selectedLocators.has(locator),
  ).length;
  const relevantPresent = factsPresent.filter((fact) =>
    requiredIds.has(fact.id),
  ).length;
  return {
    evidenceRecall: expectedPresent / expected.size,
    evidencePrecision:
      selectedLocators.size === 0 ? 0 : expectedPresent / selectedLocators.size,
    factRecall: requiredPresent / requiredIds.size,
    factPrecision:
      factsPresent.length === 0 ? 0 : relevantPresent / factsPresent.length,
    answerSupportSufficient:
      requiredPresent === requiredIds.size &&
      ![...forbiddenIds].some((id) => presentIds.has(id)),
    inputTokens: estimateContextTokens(query) + estimateContextTokens(context),
    inputBytes: utf8Bytes(query) + utf8Bytes(context),
    selectedEvidenceCount: selected.length,
    logicalEgressBytes,
  };
}

interface SimpleChunkEvidence {
  readonly evidenceLocator: string;
  readonly content: string;
  readonly ordinal: number;
}

function simpleChunks(): readonly SimpleChunkEvidence[] {
  const chunks: SimpleChunkEvidence[] = [];
  for (const evidence of frozenContextEvidence()) {
    const words = evidence.content.split(/\s+/u);
    for (let offset = 0; offset < words.length; offset += 18) {
      chunks.push({
        evidenceLocator: evidence.evidenceLocator,
        content: words.slice(offset, offset + 18).join(' '),
        ordinal: chunks.length,
      });
    }
  }
  return chunks;
}

function simpleChunkSelection(
  testCase: ContextBenchmarkCase,
): readonly SimpleChunkEvidence[] {
  const queryTerms = terms(testCase.query);
  const ranked = simpleChunks()
    .map((chunk) => ({
      chunk,
      score: queryTerms.filter((term) =>
        chunk.content.toLocaleLowerCase('en-US').includes(term),
      ).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodePointStrings(
          left.chunk.evidenceLocator,
          right.chunk.evidenceLocator,
        ) ||
        left.chunk.ordinal - right.chunk.ordinal,
    );
  const selected: SimpleChunkEvidence[] = [];
  for (const candidate of ranked) {
    const next = [...selected, candidate.chunk];
    if (
      estimateContextTokens(assembleEvidenceContext(next)) >
      testCase.maxContextTokens
    ) {
      continue;
    }
    selected.push(candidate.chunk);
    if (selected.length === 8) break;
  }
  return selected;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregate(
  values: readonly ContextCaseMetrics[],
): ContextAggregateMetrics {
  const sortedTokens = values
    .map((value) => value.inputTokens)
    .sort((left, right) => left - right);
  return {
    macroEvidenceRecall: average(values.map((value) => value.evidenceRecall)),
    macroEvidencePrecision: average(
      values.map((value) => value.evidencePrecision),
    ),
    macroFactRecall: average(values.map((value) => value.factRecall)),
    macroFactPrecision: average(values.map((value) => value.factPrecision)),
    sufficiencyRate: average(
      values.map((value) => (value.answerSupportSufficient ? 1 : 0)),
    ),
    meanInputTokens: average(values.map((value) => value.inputTokens)),
    p95InputTokens: sortedTokens[Math.ceil(sortedTokens.length * 0.95) - 1]!,
    totalInputBytes: values.reduce((sum, value) => sum + value.inputBytes, 0),
    logicalEgressBytes: values.reduce(
      (sum, value) => sum + value.logicalEgressBytes,
      0,
    ),
  };
}

class BenchmarkExternalAdapter implements StageAdapter {
  readonly kind = 'benchmark-external';
  calls = 0;
  readonly #logicalEgressBytes: number | undefined;

  constructor(logicalEgressBytes?: number) {
    this.#logicalEgressBytes = logicalEgressBytes;
  }

  async execute(request: StageAdapterRequest) {
    this.calls += 1;
    const contextRequest = request.inputs.request as ContextRequest;
    const evidence = frozenContextEvidence().slice(0, 1);
    return {
      outputs: {
        retrieval: contextRetrievalResultSchema.parse({
          adapter: contextRequest.adapter,
          evidence,
          logicalEgressBytes:
            this.#logicalEgressBytes ??
            utf8Bytes(canonicalJson(contextRequest)) +
              evidence.reduce((sum, item) => sum + utf8Bytes(item.content), 0),
        }),
      },
    };
  }
}

const EXTERNAL_PLACEMENT = {
  targetId: 'benchmark-external',
  zone: 'benchmark-cloud',
  residencies: ['EU'],
  trustLevel: 1,
  expectedP95Ms: 50,
  costMicros: 10,
} as const;

async function safetyGate(): Promise<
  ContextSupplyChainBenchmarkReport['safety']
> {
  const local = await runContextSupplyChain({
    request: createFrozenContextRequest(),
    evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
  });
  const publicAdapter = new BenchmarkExternalAdapter();
  const publicRequest = createFrozenContextRequest(
    { id: 'benchmark-external', version: '1' },
    {
      requestId: 'benchmark-public',
      query: 'What failover probes are required?',
    },
  );
  const firstPublic = await runContextSupplyChain({
    request: publicRequest,
    evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
    retrieval: { adapter: publicAdapter, ...EXTERNAL_PLACEMENT },
  });
  const secondPublic = await runContextSupplyChain({
    request: publicRequest,
    evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
    retrieval: {
      adapter: new BenchmarkExternalAdapter(),
      ...EXTERNAL_PLACEMENT,
    },
  });
  const proofEdges = firstPublic.plan.egress.proofs
    .map((proof) => ({
      edge: `${proof.from.ref}->${proof.to.stageId}.${proof.to.inputName}`,
      transfer: proof.transfer,
      classification: proof.classification,
      allowed: proof.allowed,
    }))
    .sort((left, right) => compareCodePointStrings(left.edge, right.edge));
  const publicBoundaryProofsExact =
    canonicalJson(proofEdges) ===
      canonicalJson([
        {
          edge: 'classify.classified->retrieve.request',
          transfer: 'cross-zone',
          classification: 'public',
          allowed: true,
        },
        {
          edge: 'retrieve.retrieval->assemble.retrieval',
          transfer: 'cross-zone',
          classification: 'public',
          allowed: true,
        },
      ]) &&
    firstPublic.plan.egress.digest === secondPublic.plan.egress.digest &&
    firstPublic.artifact.accounting.logicalEgressBytes > 0 &&
    firstPublic.artifact.accounting.logicalEgressBytes <=
      publicRequest.budget.maxEgressBytes;

  async function deniedBeforeIo(options: {
    readonly request: ContextRequest;
    readonly residencies: readonly string[];
  }): Promise<boolean> {
    const adapter = new BenchmarkExternalAdapter();
    try {
      await runContextSupplyChain({
        request: options.request,
        evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
        retrieval: {
          adapter,
          ...EXTERNAL_PLACEMENT,
          residencies: options.residencies,
        },
      });
      return false;
    } catch (error) {
      return error instanceof PlannerError && adapter.calls === 0;
    }
  }
  const restrictedExternalDeniedBeforeIo = await deniedBeforeIo({
    request: createFrozenContextRequest(
      { id: 'benchmark-external', version: '1' },
      { requestId: 'benchmark-restricted', classification: 'restricted' },
    ),
    residencies: ['EU'],
  });
  const residencyMismatchDeniedBeforeIo = await deniedBeforeIo({
    request: publicRequest,
    residencies: ['US'],
  });

  const expiredAdapter = new BenchmarkExternalAdapter();
  let expiredRequestDeniedBeforeIo = false;
  try {
    await runContextSupplyChain({
      request: publicRequest,
      evaluatedAt: '2027-01-01T00:00:00.000Z',
      retrieval: { adapter: expiredAdapter, ...EXTERNAL_PLACEMENT },
    });
  } catch (error) {
    expiredRequestDeniedBeforeIo =
      error instanceof ContextSupplyChainError && expiredAdapter.calls === 0;
  }

  const tamperedAdapter = new BenchmarkExternalAdapter();
  let tamperedRequestDeniedBeforeIo = false;
  try {
    await runContextSupplyChain({
      request: { ...publicRequest, query: `${publicRequest.query}!` },
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
      retrieval: { adapter: tamperedAdapter, ...EXTERNAL_PLACEMENT },
    });
  } catch (error) {
    tamperedRequestDeniedBeforeIo =
      error instanceof ContextSupplyChainError && tamperedAdapter.calls === 0;
  }

  const pageIndexBase = createFrozenContextRequest({
    id: PAGEINDEX_CONTEXT_ADAPTER_ID,
    version: PAGEINDEX_CONTEXT_ADAPTER_VERSION,
  });
  const { digest: _pageIndexDigest, ...pageIndexContent } = pageIndexBase;
  const pageIndexRequest = sealContextRequest({
    ...pageIndexContent,
    requestId: 'benchmark-pageindex-budget',
    budget: { ...pageIndexContent.budget, maxEgressBytes: 1 },
  });
  let pageIndexIoCalls = 0;
  const countPageIndexIo = async () => {
    pageIndexIoCalls += 1;
    return {};
  };
  const pageIndexAdapter = new PageIndexContextStageAdapter({
    client: {
      getDocument: countPageIndexIo,
      getDocumentStructure: countPageIndexIo,
      getPageContent: countPageIndexIo,
    },
    sources: pageIndexRequest.sources.map((source) => ({
      sourceId: source.id,
      docName: `${source.id}.pdf`,
      sourceLocator: source.sourceLocator,
      sourceDigest: source.sourceDigest,
      indexLocator: source.indexLocator,
      indexDigest: source.indexDigest,
      classification: source.classification,
      freshness: source.freshness,
      evidenceLocatorPrefix: `urn:pageindex:${source.id}:page:`,
    })),
    selector: { selectPages: () => [1] },
    now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
  });
  let requestOverBudgetDeniedBeforePageIndexIo = false;
  try {
    await runContextSupplyChain({
      request: pageIndexRequest,
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
      retrieval: {
        adapter: pageIndexAdapter,
        ...EXTERNAL_PLACEMENT,
        targetId: 'benchmark-pageindex',
      },
    });
  } catch (error) {
    requestOverBudgetDeniedBeforePageIndexIo =
      isExecutionError(error) &&
      error.stageId === 'retrieve' &&
      pageIndexIoCalls === 0;
  }

  const evidenceBudgetRequest = createFrozenContextRequest(
    { id: 'benchmark-external', version: '1' },
    { requestId: 'benchmark-evidence-budget' },
  );
  const evidenceBudgetAdapter = new BenchmarkExternalAdapter(
    evidenceBudgetRequest.budget.maxEgressBytes + 1,
  );
  let reasonCalls = 0;
  let evidenceOverBudgetDeniedBeforeArtifact = false;
  try {
    await runContextSupplyChain({
      request: evidenceBudgetRequest,
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
      retrieval: { adapter: evidenceBudgetAdapter, ...EXTERNAL_PLACEMENT },
      reasoner: {
        reason: () => {
          reasonCalls += 1;
          return { answer: 'must not run', citations: [] };
        },
      },
    });
  } catch (error) {
    evidenceOverBudgetDeniedBeforeArtifact =
      isExecutionError(error) &&
      error.stageId === 'assemble' &&
      evidenceBudgetAdapter.calls === 1 &&
      reasonCalls === 0;
  }
  const localHasNoBoundaryProofs =
    local.plan.egress.proofs.length === 0 &&
    local.artifact.accounting.logicalEgressBytes === 0;
  const passed =
    localHasNoBoundaryProofs &&
    publicBoundaryProofsExact &&
    restrictedExternalDeniedBeforeIo &&
    residencyMismatchDeniedBeforeIo &&
    expiredRequestDeniedBeforeIo &&
    tamperedRequestDeniedBeforeIo &&
    requestOverBudgetDeniedBeforePageIndexIo &&
    evidenceOverBudgetDeniedBeforeArtifact;
  return {
    localHasNoBoundaryProofs,
    publicBoundaryProofsExact,
    restrictedExternalDeniedBeforeIo,
    residencyMismatchDeniedBeforeIo,
    expiredRequestDeniedBeforeIo,
    tamperedRequestDeniedBeforeIo,
    requestOverBudgetDeniedBeforePageIndexIo,
    evidenceOverBudgetDeniedBeforeArtifact,
    passed,
  };
}

function deterministicReportProjection(
  report: Omit<
    ContextSupplyChainBenchmarkReport,
    'digest' | 'measuredLatencyMs'
  >,
) {
  return report;
}

export async function benchmarkContextSupplyChain(
  caseOrder: readonly string[] = CONTEXT_BENCHMARK_CASES.map(
    (testCase) => testCase.id,
  ),
): Promise<ContextSupplyChainBenchmarkReport> {
  const knownCases = new Map(
    CONTEXT_BENCHMARK_CASES.map((testCase) => [testCase.id, testCase]),
  );
  if (
    caseOrder.length !== knownCases.size ||
    new Set(caseOrder).size !== knownCases.size ||
    caseOrder.some((id) => !knownCases.has(id))
  ) {
    throw new TypeError('context_benchmark_case_order_invalid');
  }
  const orderedCases = caseOrder
    .map((id) => knownCases.get(id)!)
    .sort((left, right) => compareCodePointStrings(left.id, right.id));
  const rows: ContextSupplyChainBenchmarkReport['cases'][number][] = [];
  let contextLatency = 0;
  let simpleLatency = 0;
  let fullLatency = 0;
  let planDigestsReproducible = true;
  for (const testCase of orderedCases) {
    const request = createFrozenContextRequest(undefined, {
      requestId: testCase.id,
      query: testCase.query,
      maxContextTokens: testCase.maxContextTokens,
    });
    let started = performance.now();
    const first = await runContextSupplyChain({
      request,
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
    });
    contextLatency += performance.now() - started;
    const second = await runContextSupplyChain({
      request,
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
    });
    planDigestsReproducible &&= first.plan.digest === second.plan.digest;
    const candidate = scoreContext(
      testCase,
      first.artifact.evidence,
      testCase.query,
      first.artifact.accounting.logicalEgressBytes,
    );

    started = performance.now();
    const chunks = simpleChunkSelection(testCase);
    const simpleChunk = scoreContext(testCase, chunks, testCase.query, 0);
    simpleLatency += performance.now() - started;

    started = performance.now();
    const allEvidence = frozenContextEvidence();
    const fullContext = scoreContext(testCase, allEvidence, testCase.query, 0);
    fullLatency += performance.now() - started;
    rows.push({
      id: testCase.id,
      candidate,
      simpleChunk,
      fullContext,
      planDigest: first.plan.digest,
    });
  }
  const contextSupplyChain = aggregate(rows.map((row) => row.candidate));
  const simpleChunk = aggregate(rows.map((row) => row.simpleChunk));
  const fullContext = aggregate(rows.map((row) => row.fullContext));
  const safety = await safetyGate();
  const qualityAtLeastSimpleChunk =
    contextSupplyChain.macroFactRecall >= simpleChunk.macroFactRecall &&
    contextSupplyChain.macroFactPrecision >= simpleChunk.macroFactPrecision &&
    contextSupplyChain.sufficiencyRate >= simpleChunk.sufficiencyRate;
  const qualityStrictlyBetter =
    contextSupplyChain.macroFactRecall >= simpleChunk.macroFactRecall + 0.01 ||
    contextSupplyChain.macroFactPrecision >=
      simpleChunk.macroFactPrecision + 0.01 ||
    contextSupplyChain.sufficiencyRate >= simpleChunk.sufficiencyRate + 0.01;
  const costNoWorse =
    contextSupplyChain.meanInputTokens <= simpleChunk.meanInputTokens &&
    contextSupplyChain.p95InputTokens <= simpleChunk.p95InputTokens &&
    contextSupplyChain.totalInputBytes <= simpleChunk.totalInputBytes;
  const costStrictlyBetter =
    contextSupplyChain.meanInputTokens < simpleChunk.meanInputTokens ||
    contextSupplyChain.p95InputTokens < simpleChunk.p95InputTokens ||
    contextSupplyChain.totalInputBytes < simpleChunk.totalInputBytes;
  const sameBaselinePareto =
    qualityAtLeastSimpleChunk &&
    costNoWorse &&
    (qualityStrictlyBetter || costStrictlyBetter);
  const contextReducedAgainstFull =
    contextSupplyChain.meanInputTokens < fullContext.meanInputTokens &&
    contextSupplyChain.totalInputBytes < fullContext.totalInputBytes;
  const reproducible = planDigestsReproducible;
  const killGate = {
    safetyPassed: safety.passed,
    qualityAtLeastSimpleChunk,
    sameBaselinePareto,
    contextReducedAgainstFull,
    reproducible,
    passed:
      safety.passed &&
      qualityAtLeastSimpleChunk &&
      sameBaselinePareto &&
      contextReducedAgainstFull &&
      reproducible,
  };
  const deterministic = {
    corpus: {
      id: 'stagefabric-context-corpus-v2' as const,
      factManifestDigest: sha256Digest(CONTEXT_BENCHMARK_FACTS),
      caseManifestDigest: sha256Digest(CONTEXT_BENCHMARK_CASES),
    },
    cases: rows,
    methods: { contextSupplyChain, simpleChunk, fullContext },
    safety,
    reproducibility: {
      planDigestsReproducible,
      reportDigestReproducible: true,
    },
    killGate,
  };
  const digest = sha256Digest(deterministicReportProjection(deterministic));
  return {
    ...deterministic,
    measuredLatencyMs: {
      contextSupplyChain: contextLatency,
      simpleChunk: simpleLatency,
      fullContext: fullLatency,
    },
    digest,
  };
}

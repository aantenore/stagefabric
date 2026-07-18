import { describe, expect, it, vi } from 'vitest';

import {
  PAGEINDEX_CONTEXT_ADAPTER_ID,
  PAGEINDEX_CONTEXT_ADAPTER_VERSION,
  PageIndexContextStageAdapter,
} from '../../src/adapters/pageindex-context-stage-adapter.js';
import {
  CONTEXT_BENCHMARK_CASES,
  benchmarkContextSupplyChain,
} from '../../src/composition/context-supply-chain-benchmark.js';
import {
  ContextSupplyChainError,
  FROZEN_CONTEXT_EVALUATED_AT,
  createFrozenContextRequest,
  runContextSupplyChain,
  runFrozenContextSupplyChain,
} from '../../src/composition/context-supply-chain.js';
import { FROZEN_EXPECTED_EVIDENCE_LOCATORS } from '../../src/composition/context-supply-chain-corpus.js';
import { sha256Digest } from '../../src/domain/canonical.js';
import { sealContextRequest } from '../../src/domain/context-supply-chain.js';
import { PlannerError } from '../../src/application/planner.js';

describe('Context Supply Chain', () => {
  it('runs classify -> retrieve -> assemble -> reason with deterministic provenance', async () => {
    const first = await runFrozenContextSupplyChain();
    const second = await runFrozenContextSupplyChain();

    expect(first.plan.stages.map((stage) => stage.stageId)).toEqual([
      'classify',
      'retrieve',
      'assemble',
      'reason',
    ]);
    expect(first.plan.digest).toBe(second.plan.digest);
    expect(first.plan.egress.proofs).toEqual([]);
    expect(first.reasoning.citations).toEqual(
      expect.arrayContaining([...FROZEN_EXPECTED_EVIDENCE_LOCATORS]),
    );
    expect(first.artifact.accounting.logicalEgressBytes).toBe(0);
    expect(first.receipt.accounting.outputBytes).toBe(
      first.reasoning.accounting.outputBytes,
    );
    expect(first.receipt.accounting.outputTokens).toBe(
      first.reasoning.accounting.outputTokens,
    );
    expect(first.artifact.provenance).toMatchObject({
      requestDigest: createFrozenContextRequest().digest,
      planDigest: first.plan.digest,
      egressDigest: first.plan.egress.digest,
      stageIds: ['classify', 'retrieve', 'assemble'],
    });
  });

  it('passes the multi-case gate only when safety and same-baseline Pareto hold', async () => {
    const report = await benchmarkContextSupplyChain();
    const permuted = await benchmarkContextSupplyChain(
      CONTEXT_BENCHMARK_CASES.map((testCase) => testCase.id).reverse(),
    );

    expect(report.killGate).toMatchObject({
      safetyPassed: true,
      sameBaselinePareto: true,
      contextReducedAgainstFull: true,
      reproducible: true,
      passed: true,
    });
    expect(report.safety.passed).toBe(true);
    expect(report.cases).toHaveLength(10);
    expect(permuted.digest).toBe(report.digest);
  });

  it('projects the external PageIndex boundary into the core egress ledger', async () => {
    const request = createFrozenContextRequest({
      id: PAGEINDEX_CONTEXT_ADAPTER_ID,
      version: PAGEINDEX_CONTEXT_ADAPTER_VERSION,
    });
    const client = {
      getDocument: vi.fn(async ({ docName }: { docName: string }) => ({
        id: `id-${docName}`,
        name: docName,
        description: 'Test',
        status: 'completed',
        createdAt: '2026-07-01T00:00:00.000Z',
        pageNum: 2,
        next_steps: {},
      })),
      getDocumentStructure: vi.fn(async ({ docName }: { docName: string }) => ({
        doc_name: docName,
        structure: 'Relevant policy on page 1',
        total_parts: 1,
        next_steps: {},
      })),
      getPageContent: vi.fn(
        async ({ docName, pages }: { docName: string; pages: string }) => ({
          doc_name: docName,
          total_pages: 2,
          requested_pages: pages,
          returned_pages: pages,
          content: [{ page: 1, text: `Evidence from ${docName}` }],
          next_steps: {},
        }),
      ),
    };
    const adapter = new PageIndexContextStageAdapter({
      client,
      sources: request.sources.map((source) => ({
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

    const result = await runContextSupplyChain({
      request,
      retrieval: {
        adapter,
        targetId: 'pageindex-external',
        zone: 'pageindex-cloud',
        residencies: ['EU'],
        trustLevel: 1,
        expectedP95Ms: 50,
        costMicros: 10,
      },
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
    });

    expect(result.plan.stages[1]!.primary.targetId).toBe('pageindex-external');
    expect(result.plan.egress.proofs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transfer: 'cross-zone',
          classification: 'public',
          allowed: true,
        }),
      ]),
    );
    expect(result.artifact.accounting.logicalEgressBytes).toBeGreaterThan(0);
  });

  it('rejects non-public PageIndex placement before any external adapter call', async () => {
    const publicRequest = createFrozenContextRequest({
      id: PAGEINDEX_CONTEXT_ADAPTER_ID,
      version: PAGEINDEX_CONTEXT_ADAPTER_VERSION,
    });
    const { digest: _digest, ...content } = publicRequest;
    const restricted = sealContextRequest({
      ...content,
      classification: 'restricted',
    });
    const client = {
      getDocument: vi.fn(),
      getDocumentStructure: vi.fn(),
      getPageContent: vi.fn(),
    };
    const adapter = new PageIndexContextStageAdapter({
      client,
      sources: restricted.sources.map((source) => ({
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

    await expect(
      runContextSupplyChain({
        request: restricted,
        retrieval: {
          adapter,
          targetId: 'pageindex-external',
          zone: 'pageindex-cloud',
          residencies: ['EU'],
          trustLevel: 1,
          expectedP95Ms: 50,
          costMicros: 10,
        },
        evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
      }),
    ).rejects.toBeInstanceOf(PlannerError);
    expect(client.getDocument).not.toHaveBeenCalled();
  });

  it('evaluates freshness at execution time and rejects future requests', async () => {
    const staleRun = runContextSupplyChain({
      request: createFrozenContextRequest(),
      evaluatedAt: '2027-01-01T00:00:00.000Z',
    });
    await expect(staleRun).rejects.toBeInstanceOf(ContextSupplyChainError);
    await expect(staleRun).rejects.toMatchObject({
      code: 'context_source_not_fresh',
    });

    const frozen = createFrozenContextRequest();
    const { digest: _digest, ...content } = frozen;
    const future = sealContextRequest({
      ...content,
      requestedAt: '2026-07-18T10:00:01.000Z',
    });
    const futureRun = runContextSupplyChain({
      request: future,
      evaluatedAt: FROZEN_CONTEXT_EVALUATED_AT,
      maxFutureSkewMs: 0,
    });
    await expect(futureRun).rejects.toBeInstanceOf(ContextSupplyChainError);
    await expect(futureRun).rejects.toMatchObject({
      code: 'context_request_from_future',
    });
  });

  it('selects the earliest source expiry by epoch and normalizes it to UTC', async () => {
    const frozen = createFrozenContextRequest({
      id: 'fixture-external',
      version: '1',
    });
    const { digest: _digest, ...content } = frozen;
    const sources = content.sources.map((source, index) => ({
      ...source,
      freshness: {
        observedAt: '2026-07-18T07:00:00.000Z',
        expiresAt:
          index === 0
            ? '2026-07-18T12:00:00+03:00'
            : index === 1
              ? '2026-07-18T10:30:00+00:00'
              : '2026-07-18T20:00:00+00:00',
      },
    }));
    const request = sealContextRequest({
      ...content,
      requestedAt: '2026-07-18T08:00:00.000Z',
      sources,
    });
    const source = request.sources[0]!;
    const evidenceContent = 'Bounded evidence for mixed-offset expiry.';
    const adapter = {
      kind: 'fixture-context',
      execute: vi.fn(async () => ({
        outputs: {
          retrieval: {
            adapter: request.adapter,
            evidence: [
              {
                sourceId: source.id,
                sourceLocator: source.sourceLocator,
                evidenceLocator: `${source.sourceLocator}#evidence`,
                sourceDigest: source.sourceDigest,
                indexDigest: source.indexDigest,
                content: evidenceContent,
                contentDigest: sha256Digest(evidenceContent),
                classification: source.classification,
                observedAt: source.freshness.observedAt,
              },
            ],
            logicalEgressBytes: 0,
          },
        },
      })),
    };

    const result = await runContextSupplyChain({
      request,
      retrieval: {
        adapter,
        targetId: 'fixture-external',
        zone: 'fixture-zone',
        residencies: ['EU'],
        trustLevel: 1,
        expectedP95Ms: 1,
        costMicros: 0,
      },
      evaluatedAt: '2026-07-18T08:30:00.000Z',
    });

    expect(result.artifact.freshness.expiresAt).toBe(
      '2026-07-18T09:00:00.000Z',
    );
  });
});

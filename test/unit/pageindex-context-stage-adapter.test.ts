import { describe, expect, it, vi } from 'vitest';

import {
  PAGEINDEX_CONTEXT_ADAPTER_ID,
  PAGEINDEX_CONTEXT_ADAPTER_VERSION,
  PageIndexContextStageAdapter,
  type PageIndexSourceBinding,
  type PageIndexToolsPort,
} from '../../src/adapters/pageindex-context-stage-adapter.js';
import {
  FROZEN_CONTEXT_EVALUATED_AT,
  createFrozenContextRequest,
} from '../../src/composition/context-supply-chain.js';
import { canonicalJson, sha256Digest } from '../../src/domain/canonical.js';
import {
  contextRetrievalResultSchema,
  sealContextRequest,
} from '../../src/domain/context-supply-chain.js';
import { StageAdapterError } from '../../src/ports/stage-adapter.js';

function request() {
  return createFrozenContextRequest({
    id: PAGEINDEX_CONTEXT_ADAPTER_ID,
    version: PAGEINDEX_CONTEXT_ADAPTER_VERSION,
  });
}

function bindings(): readonly PageIndexSourceBinding[] {
  return request().sources.map((source) => ({
    sourceId: source.id,
    docName: `${source.id}.pdf`,
    folderId: 'approved-folder',
    sourceLocator: source.sourceLocator,
    sourceDigest: source.sourceDigest,
    indexLocator: source.indexLocator,
    indexDigest: source.indexDigest,
    classification: source.classification,
    freshness: source.freshness,
    evidenceLocatorPrefix: `urn:pageindex:${source.id}:page:`,
  }));
}

function client(
  overrides: Partial<PageIndexToolsPort> = {},
): PageIndexToolsPort {
  return {
    getDocument: vi.fn(async ({ docName }) => ({
      id: `id-${docName}`,
      name: docName,
      description: 'Frozen test document',
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      pageNum: 4,
      next_steps: { summary: 'ready', options: [] },
    })),
    getDocumentStructure: vi.fn(async ({ docName, part }) => ({
      doc_name: docName,
      structure: `Part ${part ?? 1}: policy on page 2`,
      total_parts: 1,
      next_steps: { summary: 'read pages', options: [] },
    })),
    getPageContent: vi.fn(async ({ docName, pages }) => ({
      doc_name: docName,
      total_pages: 4,
      requested_pages: pages,
      returned_pages: pages,
      content: [{ page: 2, text: `Evidence from ${docName}` }],
      next_steps: { summary: 'answer', options: [] },
    })),
    ...overrides,
  };
}

function execute(
  adapter: PageIndexContextStageAdapter,
  contextRequest = request(),
) {
  return adapter.execute({
    stageId: 'retrieve',
    operation: 'context.retrieve',
    targetId: 'pageindex-external',
    zone: 'external',
    inputs: { request: contextRequest },
    expectedOutputs: ['retrieval'],
  });
}

describe('PageIndexContextStageAdapter', () => {
  it('uses the official status, structure, page workflow through an injected client', async () => {
    const tools = client();
    const adapter = new PageIndexContextStageAdapter({
      client: tools,
      sources: bindings(),
      selector: { selectPages: () => [2] },
      now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
    });

    const result = await execute(adapter);
    const retrieval = contextRetrievalResultSchema.parse(
      result.outputs.retrieval,
    );

    expect(retrieval.evidence).toHaveLength(3);
    expect(retrieval.evidence[0]!.evidenceLocator).toContain('page:2');
    expect(retrieval.logicalEgressBytes).toBeGreaterThan(0);
    expect(tools.getDocument).toHaveBeenCalledTimes(3);
    expect(tools.getDocumentStructure).toHaveBeenCalledTimes(3);
    expect(tools.getPageContent).toHaveBeenCalledTimes(3);
    expect(tools.getDocument).toHaveBeenCalledWith({
      docName: 'edge-operations.pdf',
      folderId: 'approved-folder',
      waitForCompletion: false,
    });
  });

  it('fails closed on a non-completed document or mismatched returned page', async () => {
    const pending = client({
      getDocument: vi.fn(async ({ docName }) => ({
        id: 'pending',
        name: docName,
        description: '',
        status: 'processing',
        createdAt: '2026-07-01T00:00:00.000Z',
        pageNum: 4,
        next_steps: { summary: 'wait', options: [] },
      })),
    });
    const pendingAdapter = new PageIndexContextStageAdapter({
      client: pending,
      sources: bindings(),
      selector: { selectPages: () => [2] },
      now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
    });
    await expect(execute(pendingAdapter)).rejects.toMatchObject({
      code: 'adapter_failure',
    });
    expect(pending.getDocumentStructure).not.toHaveBeenCalled();

    const mismatched = client({
      getPageContent: vi.fn(async ({ docName, pages }) => ({
        doc_name: docName,
        total_pages: 4,
        requested_pages: pages,
        returned_pages: '3',
        content: [{ page: 3, text: 'Wrong page' }],
        next_steps: { summary: 'answer', options: [] },
      })),
    });
    await expect(
      execute(
        new PageIndexContextStageAdapter({
          client: mismatched,
          sources: bindings(),
          selector: { selectPages: () => [2] },
          now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
        }),
      ),
    ).rejects.toBeInstanceOf(StageAdapterError);
  });

  it('rejects a tampered source binding and an over-budget request before I/O', async () => {
    const tools = client();
    const adapter = new PageIndexContextStageAdapter({
      client: tools,
      sources: bindings(),
      selector: { selectPages: () => [2] },
      now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
    });
    const original = request();
    const tampered = {
      ...original,
      sources: original.sources.map((source, index) =>
        index === 0 ? { ...source, sourceDigest: original.digest } : source,
      ),
    };
    await expect(
      execute(adapter, tampered as typeof original),
    ).rejects.toMatchObject({
      code: 'adapter_failure',
    });
    const { digest: _digest, ...content } = original;
    const overBudget = sealContextRequest({
      ...content,
      budget: { ...content.budget, maxEgressBytes: 1 },
    });
    await expect(execute(adapter, overBudget)).rejects.toMatchObject({
      code: 'adapter_failure',
    });
    expect(tools.getDocument).not.toHaveBeenCalled();
  });

  it('pins source classification and freshness and rechecks freshness at execution', async () => {
    const mismatchedTools = client();
    const mismatchedBindings = bindings().map((binding, index) =>
      index === 0
        ? { ...binding, classification: 'internal' as const }
        : binding,
    );
    await expect(
      execute(
        new PageIndexContextStageAdapter({
          client: mismatchedTools,
          sources: mismatchedBindings,
          selector: { selectPages: () => [2] },
          now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
        }),
      ),
    ).rejects.toMatchObject({ code: 'adapter_failure' });
    expect(mismatchedTools.getDocument).not.toHaveBeenCalled();

    const expiredTools = client();
    await expect(
      execute(
        new PageIndexContextStageAdapter({
          client: expiredTools,
          sources: bindings(),
          selector: { selectPages: () => [2] },
          now: () => new Date('2027-01-01T00:00:00.000Z'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'adapter_failure' });
    expect(expiredTools.getDocument).not.toHaveBeenCalled();
  });

  it('enforces one global call budget across a 64-source request', async () => {
    const base = request();
    const { digest: _digest, ...content } = base;
    const sources = Array.from({ length: 64 }, (_value, index) => {
      const suffix = String(index + 1).padStart(2, '0');
      return {
        ...base.sources[0]!,
        id: `source_${suffix}`,
        sourceLocator: `urn:stagefabric:bounded:source:${suffix}`,
        sourceDigest: sha256Digest({ source: suffix }),
        indexLocator: `urn:stagefabric:bounded:index:${suffix}`,
        indexDigest: sha256Digest({ index: suffix }),
      };
    });
    const many = sealContextRequest({ ...content, sources });
    const tools = client();
    const adapter = new PageIndexContextStageAdapter({
      client: tools,
      sources: sources.map((source) => ({
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
      selector: { selectPages: () => [2] },
      maxCalls: 4,
      now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
    });

    await expect(execute(adapter, many)).rejects.toMatchObject({
      code: 'adapter_failure',
    });
    expect(tools.getDocument).toHaveBeenCalledTimes(1);
    expect(tools.getDocumentStructure).toHaveBeenCalledTimes(1);
    expect(tools.getPageContent).toHaveBeenCalledTimes(1);
  });

  it('checks a fake monotonic deadline after every external call', async () => {
    let monotonic = 0;
    const tools = client({
      getDocument: vi.fn(async ({ docName }) => {
        monotonic = 6;
        return {
          id: 'late',
          name: docName,
          description: '',
          status: 'completed',
          createdAt: '2026-07-01T00:00:00.000Z',
          pageNum: 4,
          next_steps: {},
        };
      }),
    });
    const adapter = new PageIndexContextStageAdapter({
      client: tools,
      sources: bindings(),
      selector: { selectPages: () => [2] },
      timeoutMs: 100,
      totalTimeoutMs: 5,
      monotonicNow: () => monotonic,
      now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
    });

    await expect(execute(adapter)).rejects.toMatchObject({
      code: 'adapter_failure',
    });
    expect(tools.getDocument).toHaveBeenCalledTimes(1);
    expect(tools.getDocumentStructure).not.toHaveBeenCalled();
  });

  it('applies aggregate response and logical egress ceilings', async () => {
    const responseTools = client();
    await expect(
      execute(
        new PageIndexContextStageAdapter({
          client: responseTools,
          sources: bindings(),
          selector: { selectPages: () => [2] },
          maxTotalResponseBytes: 1,
          now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
        }),
      ),
    ).rejects.toMatchObject({ code: 'adapter_failure' });
    expect(responseTools.getDocumentStructure).not.toHaveBeenCalled();

    const original = request();
    const { digest: _digest, ...content } = original;
    let bounded = sealContextRequest({
      ...content,
      budget: { ...content.budget, maxEgressBytes: 4_000 },
    });
    const requestBytes = new TextEncoder().encode(
      canonicalJson(bounded),
    ).byteLength;
    bounded = sealContextRequest({
      ...content,
      budget: { ...content.budget, maxEgressBytes: requestBytes + 10 },
    });
    const evidenceTools = client();
    await expect(
      execute(
        new PageIndexContextStageAdapter({
          client: evidenceTools,
          sources: bindings(),
          selector: { selectPages: () => [2] },
          now: () => new Date(FROZEN_CONTEXT_EVALUATED_AT),
        }),
        bounded,
      ),
    ).rejects.toMatchObject({ code: 'adapter_failure' });
    expect(evidenceTools.getPageContent).toHaveBeenCalledTimes(1);
  });
});

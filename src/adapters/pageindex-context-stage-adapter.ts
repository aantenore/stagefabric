import { z } from 'zod';

import { canonicalJson, sha256Digest } from '../domain/canonical.js';
import {
  contextRequestSchema,
  contextRetrievalResultSchema,
  verifyContextRequestDigest,
  type ContextRequest,
  type ContextClassification,
  type ContextSource,
} from '../domain/context-supply-chain.js';
import {
  isStageAdapterError,
  StageAdapterError,
  type StageAdapter,
  type StageAdapterRequest,
  type StageAdapterResult,
} from '../ports/stage-adapter.js';

export const PAGEINDEX_CONTEXT_ADAPTER_ID = 'pageindex-tools' as const;
export const PAGEINDEX_CONTEXT_ADAPTER_VERSION = '0.8.0-contract.1' as const;
export const PAGEINDEX_CONTEXT_ADAPTER_KIND = 'pageindex-context' as const;

const documentSchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(1_024),
    description: z.string().max(65_536),
    status: z.string().min(1).max(64),
    createdAt: z.string().datetime({ offset: true }),
    pageNum: z.number().int().min(1).max(1_000_000).optional(),
    wait_info: z.unknown().optional(),
    next_steps: z.unknown(),
  })
  .strict();

const structureSchema = z
  .object({
    doc_name: z.string().min(1).max(1_024),
    structure: z.unknown(),
    total_parts: z.number().int().min(1).max(1_000).optional(),
    next_steps: z.unknown(),
  })
  .strict();

const pageContentSchema = z
  .object({
    doc_name: z.string().min(1).max(1_024),
    total_pages: z.number().int().min(1).max(1_000_000),
    requested_pages: z.string().min(1).max(8_192),
    returned_pages: z.string().min(1).max(8_192),
    content: z
      .array(
        z
          .object({
            page: z.number().int().min(1).max(1_000_000),
            text: z.string().min(1).max(1_000_000),
            block_id: z.string().max(512).optional(),
            image_count: z.number().int().min(0).optional(),
            image_annotations: z.array(z.string().max(65_536)).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    next_steps: z.unknown(),
  })
  .strict();

export interface PageIndexToolsPort {
  getDocument(params: {
    readonly docName: string;
    readonly waitForCompletion?: boolean;
    readonly folderId?: string | null;
  }): Promise<unknown>;
  getDocumentStructure(params: {
    readonly docName: string;
    readonly part?: number;
    readonly waitForCompletion?: boolean;
    readonly folderId?: string | null;
  }): Promise<unknown>;
  getPageContent(params: {
    readonly docName: string;
    readonly pages: string;
    readonly waitForCompletion?: boolean;
    readonly folderId?: string | null;
  }): Promise<unknown>;
}

export interface PageIndexSourceBinding {
  readonly sourceId: string;
  readonly docName: string;
  readonly folderId?: string;
  readonly sourceLocator: string;
  readonly sourceDigest: string;
  readonly indexLocator: string;
  readonly indexDigest: string;
  readonly classification: ContextClassification;
  readonly freshness: {
    readonly observedAt: string;
    readonly expiresAt: string;
  };
  readonly evidenceLocatorPrefix: string;
}

export interface PageIndexSelectionRequest {
  readonly request: ContextRequest;
  readonly source: ContextSource;
  readonly document: Readonly<{
    id: string;
    name: string;
    description: string;
    createdAt: string;
    pageNum: number;
  }>;
  readonly structures: readonly unknown[];
}

export interface PageIndexPageSelector {
  selectPages(
    request: PageIndexSelectionRequest,
  ): readonly number[] | Promise<readonly number[]>;
}

export interface PageIndexContextStageAdapterOptions {
  readonly client: PageIndexToolsPort;
  readonly selector: PageIndexPageSelector;
  readonly sources: readonly PageIndexSourceBinding[];
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxCalls?: number;
  readonly maxTotalResponseBytes?: number;
  readonly maxStructureParts?: number;
  readonly maxStructureBytes?: number;
  readonly maxPagesPerSource?: number;
  readonly maxTotalPages?: number;
  readonly maxEvidenceBytes?: number;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

function validLocator(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\S+$/u.test(value) &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 32 && codePoint !== 127;
    })
  );
}

const sourceBindingSchema = z
  .object({
    sourceId: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .max(128),
    docName: z.string().min(1).max(1_024),
    folderId: z.string().min(1).max(512).optional(),
    sourceLocator: z.string().min(3).max(2_048),
    sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    indexLocator: z.string().min(3).max(2_048),
    indexDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    classification: z.enum(['public', 'internal', 'restricted']),
    freshness: z
      .object({
        observedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .refine(
        (value) => Date.parse(value.observedAt) < Date.parse(value.expiresAt),
      ),
    evidenceLocatorPrefix: z.string().min(3).max(2_000).refine(validLocator),
  })
  .strict();

class PageIndexContractError extends Error {}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > maximum
  ) {
    throw new TypeError('pageindex_adapter_configuration_invalid');
  }
  return candidate;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function snapshotJson(
  value: unknown,
  limits: { readonly maxDepth: number; readonly maxNodes: number },
  depth = 0,
  budget = { nodes: 0 },
  ancestors = new WeakSet<object>(),
): unknown {
  budget.nodes += 1;
  if (depth > limits.maxDepth || budget.nodes > limits.maxNodes) {
    throw new PageIndexContractError();
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PageIndexContractError();
    return value;
  }
  if (typeof value !== 'object') throw new PageIndexContractError();
  if (ancestors.has(value)) throw new PageIndexContractError();
  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new PageIndexContractError();
      const length = value.length;
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new PageIndexContractError();
        }
        copy.push(
          snapshotJson(descriptor.value, limits, depth + 1, budget, ancestors),
        );
      }
      if (
        Reflect.ownKeys(descriptors).some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw new PageIndexContractError();
      }
      return Object.freeze(copy);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PageIndexContractError();
    }
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new PageIndexContractError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new PageIndexContractError();
      }
      copy[key] = snapshotJson(
        descriptor.value,
        limits,
        depth + 1,
        budget,
        ancestors,
      );
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new StageAdapterError({ code: 'timeout' })),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PageIndexWorkBudget {
  readonly deadline: number;
  calls: number;
  responseBytes: number;
  structureBytes: number;
  evidenceBytes: number;
  pages: number;
}

async function boundedWorkCall(options: {
  readonly invoke: () => Promise<unknown>;
  readonly work: PageIndexWorkBudget;
  readonly monotonicNow: () => number;
  readonly callTimeoutMs: number;
  readonly maxCalls: number;
  readonly maxTotalResponseBytes: number;
  readonly snapshotLimits: {
    readonly maxDepth: number;
    readonly maxNodes: number;
  };
  readonly countResponse?: boolean;
}): Promise<unknown> {
  const before = options.monotonicNow();
  if (!Number.isFinite(before)) throw new PageIndexContractError();
  const remaining = options.work.deadline - before;
  options.work.calls += 1;
  if (remaining <= 0 || options.work.calls > options.maxCalls) {
    throw new PageIndexContractError();
  }
  const value = await withTimeout(
    Promise.resolve().then(options.invoke),
    Math.max(1, Math.min(options.callTimeoutMs, Math.ceil(remaining))),
  );
  const after = options.monotonicNow();
  if (!Number.isFinite(after) || after > options.work.deadline) {
    throw new PageIndexContractError();
  }
  const snapshot = snapshotJson(value, options.snapshotLimits);
  if (options.countResponse !== false) {
    options.work.responseBytes += utf8Bytes(canonicalJson(snapshot));
    if (options.work.responseBytes > options.maxTotalResponseBytes) {
      throw new PageIndexContractError();
    }
  }
  return snapshot;
}

function requireRequest(value: unknown): ContextRequest {
  const parsed = contextRequestSchema.safeParse(value);
  if (!parsed.success || !verifyContextRequestDigest(parsed.data)) {
    throw new PageIndexContractError();
  }
  return parsed.data;
}

function exactBinding(
  source: ContextSource,
  binding: PageIndexSourceBinding | undefined,
): PageIndexSourceBinding {
  if (
    binding === undefined ||
    binding.sourceId !== source.id ||
    binding.sourceLocator !== source.sourceLocator ||
    binding.sourceDigest !== source.sourceDigest ||
    binding.indexLocator !== source.indexLocator ||
    binding.indexDigest !== source.indexDigest ||
    binding.classification !== source.classification ||
    binding.freshness.observedAt !== source.freshness.observedAt ||
    binding.freshness.expiresAt !== source.freshness.expiresAt
  ) {
    throw new PageIndexContractError();
  }
  return binding;
}

/**
 * Optional PageIndex retrieval target for the Context Supply Chain.
 *
 * The host imports and constructs `@pageindex/sdk`, then injects `client.tools`.
 * This adapter owns no endpoint, credential, package import, or dynamic module
 * lookup. It mirrors the official v0.8.0 tools workflow: document status,
 * structure, then narrowly selected page content.
 */
export class PageIndexContextStageAdapter implements StageAdapter {
  readonly kind = PAGEINDEX_CONTEXT_ADAPTER_KIND;
  readonly #client: PageIndexToolsPort;
  readonly #selector: PageIndexPageSelector;
  readonly #sources: ReadonlyMap<string, PageIndexSourceBinding>;
  readonly #timeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxCalls: number;
  readonly #maxTotalResponseBytes: number;
  readonly #maxStructureParts: number;
  readonly #maxStructureBytes: number;
  readonly #maxPagesPerSource: number;
  readonly #maxTotalPages: number;
  readonly #maxEvidenceBytes: number;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;

  constructor(options: PageIndexContextStageAdapterOptions) {
    if (
      typeof options.client?.getDocument !== 'function' ||
      typeof options.client?.getDocumentStructure !== 'function' ||
      typeof options.client?.getPageContent !== 'function' ||
      typeof options.selector?.selectPages !== 'function'
    ) {
      throw new TypeError('pageindex_adapter_configuration_invalid');
    }
    this.#client = options.client;
    this.#selector = options.selector;
    this.#timeoutMs = positiveInteger(options.timeoutMs, 15_000, 300_000);
    this.#totalTimeoutMs = positiveInteger(
      options.totalTimeoutMs,
      30_000,
      300_000,
    );
    this.#maxCalls = positiveInteger(options.maxCalls, 64, 512);
    this.#maxTotalResponseBytes = positiveInteger(
      options.maxTotalResponseBytes,
      4_000_000,
      32_000_000,
    );
    this.#maxStructureParts = positiveInteger(options.maxStructureParts, 8, 64);
    this.#maxStructureBytes = positiveInteger(
      options.maxStructureBytes,
      2_000_000,
      16_000_000,
    );
    this.#maxPagesPerSource = positiveInteger(
      options.maxPagesPerSource,
      8,
      128,
    );
    this.#maxTotalPages = positiveInteger(options.maxTotalPages, 64, 1_024);
    this.#maxEvidenceBytes = positiveInteger(
      options.maxEvidenceBytes,
      1_000_000,
      16_000_000,
    );
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    if (
      typeof this.#now !== 'function' ||
      typeof this.#monotonicNow !== 'function'
    ) {
      throw new TypeError('pageindex_adapter_configuration_invalid');
    }
    const sources: readonly PageIndexSourceBinding[] = options.sources.map(
      (source) => {
        const parsed = sourceBindingSchema.parse(source);
        return Object.freeze({
          sourceId: parsed.sourceId,
          docName: parsed.docName,
          ...(parsed.folderId === undefined
            ? {}
            : { folderId: parsed.folderId }),
          sourceLocator: parsed.sourceLocator,
          sourceDigest: parsed.sourceDigest,
          indexLocator: parsed.indexLocator,
          indexDigest: parsed.indexDigest,
          classification: parsed.classification,
          freshness: Object.freeze({
            observedAt: parsed.freshness.observedAt,
            expiresAt: parsed.freshness.expiresAt,
          }),
          evidenceLocatorPrefix: parsed.evidenceLocatorPrefix,
        });
      },
    );
    if (
      sources.length < 1 ||
      sources.length > 64 ||
      new Set(sources.map((source) => source.sourceId)).size !== sources.length
    ) {
      throw new TypeError('pageindex_adapter_configuration_invalid');
    }
    this.#sources = new Map(sources.map((source) => [source.sourceId, source]));
  }

  async execute(request: StageAdapterRequest): Promise<StageAdapterResult> {
    try {
      if (
        request.operation !== 'context.retrieve' ||
        request.expectedOutputs.length !== 1 ||
        request.expectedOutputs[0] !== 'retrieval' ||
        !Object.hasOwn(request.inputs, 'request')
      ) {
        throw new PageIndexContractError();
      }
      const contextRequest = requireRequest(request.inputs.request);
      if (
        contextRequest.adapter.id !== PAGEINDEX_CONTEXT_ADAPTER_ID ||
        contextRequest.adapter.version !== PAGEINDEX_CONTEXT_ADAPTER_VERSION
      ) {
        throw new PageIndexContractError();
      }
      const started = this.#monotonicNow();
      const executionEpoch = this.#now().getTime();
      if (!Number.isFinite(started) || !Number.isFinite(executionEpoch)) {
        throw new PageIndexContractError();
      }
      const work: PageIndexWorkBudget = {
        deadline: started + this.#totalTimeoutMs,
        calls: 0,
        responseBytes: 0,
        structureBytes: 0,
        evidenceBytes: 0,
        pages: 0,
      };
      const call = (
        invoke: () => Promise<unknown>,
        snapshotLimits: {
          readonly maxDepth: number;
          readonly maxNodes: number;
        },
        countResponse = true,
      ) =>
        boundedWorkCall({
          invoke,
          work,
          monotonicNow: this.#monotonicNow,
          callTimeoutMs: this.#timeoutMs,
          maxCalls: this.#maxCalls,
          maxTotalResponseBytes: this.#maxTotalResponseBytes,
          snapshotLimits,
          countResponse,
        });
      const requestBytes = utf8Bytes(canonicalJson(contextRequest));
      if (requestBytes > contextRequest.budget.maxEgressBytes) {
        throw new PageIndexContractError();
      }

      const evidence = [];
      for (const source of contextRequest.sources) {
        const binding = exactBinding(source, this.#sources.get(source.id));
        if (
          Date.parse(binding.freshness.observedAt) > executionEpoch ||
          Date.parse(binding.freshness.expiresAt) <= executionEpoch
        ) {
          throw new PageIndexContractError();
        }
        const document = documentSchema.parse(
          await call(
            () =>
              this.#client.getDocument({
                docName: binding.docName,
                waitForCompletion: false,
                ...(binding.folderId === undefined
                  ? {}
                  : { folderId: binding.folderId }),
              }),
            { maxDepth: 16, maxNodes: 10_000 },
          ),
        );
        if (
          document.name !== binding.docName ||
          document.status !== 'completed' ||
          document.pageNum === undefined
        ) {
          throw new PageIndexContractError();
        }
        const pageCount = document.pageNum;

        const first = structureSchema.parse(
          await call(
            () =>
              this.#client.getDocumentStructure({
                docName: binding.docName,
                waitForCompletion: false,
                ...(binding.folderId === undefined
                  ? {}
                  : { folderId: binding.folderId }),
              }),
            { maxDepth: 64, maxNodes: 100_000 },
          ),
        );
        const partCount = first.total_parts ?? 1;
        if (
          first.doc_name !== binding.docName ||
          partCount > this.#maxStructureParts
        ) {
          throw new PageIndexContractError();
        }
        const structures: unknown[] = [
          snapshotJson(first.structure, { maxDepth: 64, maxNodes: 100_000 }),
        ];
        work.structureBytes += utf8Bytes(canonicalJson(structures[0]));
        if (work.structureBytes > this.#maxStructureBytes) {
          throw new PageIndexContractError();
        }
        for (let part = 2; part <= partCount; part += 1) {
          const next = structureSchema.parse(
            await call(
              () =>
                this.#client.getDocumentStructure({
                  docName: binding.docName,
                  part,
                  waitForCompletion: false,
                  ...(binding.folderId === undefined
                    ? {}
                    : { folderId: binding.folderId }),
                }),
              { maxDepth: 64, maxNodes: 100_000 },
            ),
          );
          if (
            next.doc_name !== binding.docName ||
            next.total_parts !== partCount
          ) {
            throw new PageIndexContractError();
          }
          const structure = snapshotJson(next.structure, {
            maxDepth: 64,
            maxNodes: 100_000,
          });
          structures.push(structure);
          work.structureBytes += utf8Bytes(canonicalJson(structure));
          if (work.structureBytes > this.#maxStructureBytes) {
            throw new PageIndexContractError();
          }
        }

        const selected = z.array(z.number()).parse(
          await call(
            () =>
              Promise.resolve(
                this.#selector.selectPages({
                  request: contextRequest,
                  source,
                  document: Object.freeze({
                    id: document.id,
                    name: document.name,
                    description: document.description,
                    createdAt: document.createdAt,
                    pageNum: pageCount,
                  }),
                  structures: Object.freeze(structures),
                }),
              ),
            { maxDepth: 2, maxNodes: this.#maxPagesPerSource + 2 },
            false,
          ),
        );
        const pages = [...selected];
        if (
          pages.length < 1 ||
          pages.length > this.#maxPagesPerSource ||
          new Set(pages).size !== pages.length ||
          pages.some(
            (page) =>
              !Number.isSafeInteger(page) || page < 1 || page > pageCount,
          )
        ) {
          throw new PageIndexContractError();
        }
        work.pages += pages.length;
        if (work.pages > this.#maxTotalPages) {
          throw new PageIndexContractError();
        }
        pages.sort((left, right) => left - right);
        const pageExpression = pages.join(',');
        const pageResult = pageContentSchema.parse(
          await call(
            () =>
              this.#client.getPageContent({
                docName: binding.docName,
                pages: pageExpression,
                waitForCompletion: false,
                ...(binding.folderId === undefined
                  ? {}
                  : { folderId: binding.folderId }),
              }),
            { maxDepth: 32, maxNodes: 100_000 },
          ),
        );
        const returnedPages = pageResult.content.map((item) => item.page);
        if (
          pageResult.doc_name !== binding.docName ||
          pageResult.total_pages !== pageCount ||
          pageResult.requested_pages !== pageExpression ||
          pageResult.returned_pages !== pageExpression ||
          returnedPages.length !== pages.length ||
          returnedPages.some((page, index) => page !== pages[index])
        ) {
          throw new PageIndexContractError();
        }
        for (const item of pageResult.content) {
          work.evidenceBytes += utf8Bytes(item.text);
          if (
            work.evidenceBytes > this.#maxEvidenceBytes ||
            requestBytes + work.evidenceBytes >
              contextRequest.budget.maxEgressBytes
          ) {
            throw new PageIndexContractError();
          }
          evidence.push({
            sourceId: source.id,
            sourceLocator: source.sourceLocator,
            evidenceLocator: `${binding.evidenceLocatorPrefix}${item.page}`,
            sourceDigest: source.sourceDigest,
            indexDigest: source.indexDigest,
            content: item.text,
            contentDigest: sha256Digest(item.text),
            classification: source.classification,
            observedAt: source.freshness.observedAt,
          });
        }
      }

      return {
        outputs: {
          retrieval: contextRetrievalResultSchema.parse({
            adapter: {
              id: PAGEINDEX_CONTEXT_ADAPTER_ID,
              version: PAGEINDEX_CONTEXT_ADAPTER_VERSION,
            },
            evidence,
            logicalEgressBytes: requestBytes + work.evidenceBytes,
          }),
        },
      };
    } catch (error) {
      if (isStageAdapterError(error)) throw error;
      throw new StageAdapterError({ code: 'adapter_failure' });
    }
  }
}

# ADR 0006: treat context as a policy-governed supply chain

- Status: accepted and implemented
- Target: next alpha
- Date: 2026-07-18

## Context

An agent rarely needs every available document. Sending full sources wastes
tokens and makes provenance, freshness, and boundary decisions difficult to
review. Adding another index or a monolithic RAG implementation to StageFabric
would duplicate mature retrieval systems and couple placement policy to their
storage, model, credential, and network choices.

The missing function is narrower: plan where request classification happens,
where approved evidence is retrieved, where a bounded context artifact is
assembled, and where reasoning consumes that artifact. Source and index identity,
evidence location, freshness, budgets, and egress must survive that sequence as
typed lineage.

## Decision

StageFabric adds a `Context Supply Chain` vertical slice:

```text
ContextRequest -> classify -> retrieve -> assemble -> reason
                   |             |           |
                   +------ existing placement and egress ledger ------+
```

This is a planned stage graph, not a separate orchestration or authorization
engine. The unchanged core planner selects targets, refuses illegal
classification/residency placement, and emits its existing reason-coded egress
ledger. The unchanged executor invokes only adapters registered by the host.
In this first slice, `classify` means validate and forward the request's sealed
classification and source metadata. It is not a semantic classifier; an
application can place one upstream without changing the retrieval contract.

### Context contracts

`ContextRequest` is strict, canonical, and digest-bound. It carries:

- the query classification and residency constraints;
- source and index locators plus their SHA-256 digests;
- source classification and an explicit observed/expiry interval;
- retrieval adapter identifier and version;
- context, total-input, output-token, and egress-byte budgets;
- intent, policy, and parent-artifact provenance digests.

Canonical sealers sort residency, source, parent-digest, and evidence arrays.
Digest verification also requires the supplied raw value to already have that
canonical form, so reordering and recomputing a digest is not an alternate valid
representation. Freshness is validated when a request is sealed and again at
execution against a current or injected clock. Source expiries are compared as
epochs and the earliest intersection is emitted in UTC.

`ContextArtifact` carries the exact selected evidence locators, source/index and
content digests, classification and freshness intersection, assembled context,
token/byte accounting, retrieval adapter identity, and request/plan/egress
provenance. Its token counts use the named deterministic
`utf8-bytes-div-4-ceil@1` estimator; they are comparable gate evidence, not a
claim about a provider tokenizer.

`ContextArtifact` accounting stops at the pre-reason boundary: query, assembled
context, total input, and logical egress. After reasoning, a separate sealed
`ContextRunReceipt` binds the request, artifact, plan and egress digests to the
actual output token and byte counts. No placeholder output zeros are emitted.

The artifact is created by the `assemble` stage and verified again before the
`reason` stage. Evidence not bound to an approved request source, stale evidence,
digest mismatch, budget overflow, or a citation outside the artifact fails
closed.

### Deterministic reference path

The credential-free example uses a frozen synthetic corpus with multiple
documents, distracting sections, explicit expected evidence locators, and a
deterministic in-process retriever. It scans the supplied corpus at execution
time; it does not create or persist an index.

`stagefabric context-demo` exposes the four placements, artifact/receipt/plan/
egress digests, locators, pre-reason and consolidated accounting, answer, and
citations. `stagefabric context-benchmark` compares that path with full-context
and fixed-size simple-chunk baselines over ten frozen cases. `--enforce` turns a
failed spike gate into a non-zero CLI result.

The kill gate requires:

1. no transfer outside an allowed core egress proof and no egress-budget
   overflow;
2. identical plan/report digests for identical inputs and case-order
   permutations;
3. exact fact-span recall, precision, and answer-support sufficiency measured on
   selected evidence before any generated answer;
4. quality no worse and mean/p95 token plus byte cost no worse than the same
   simple-chunk cases, with at least one strict improvement;
5. fewer context bytes and estimated tokens than full-context input.

Latency is measured and reported but not used as a deterministic release gate.

### Optional PageIndex adapter

The optional `PageIndexContextStageAdapter` mirrors the current official
`@pageindex/sdk` v0.8.0 tool workflow: call `getDocument` to require completed
processing, call `getDocumentStructure`, then call `getPageContent` only for
tight page selections. This interface was verified against the
[official SDK repository](https://github.com/VectifyAI/pageindex-js-sdk/tree/9458a56441e75e680a5392d26f9edf9f4915580b)
and [official MCP tools documentation](https://docs.pageindex.ai/js-sdk/mcp-tools).

The host constructs the official client and injects `client.tools` plus a
trusted, bounded page selector. StageFabric has no PageIndex package dependency,
API key, endpoint, document upload, or configuration-driven import. Operator
bindings pin each request source/index digest to one document/folder and evidence
locator prefix, classification, and freshness interval. One total work deadline
and global call, response-byte, structure-byte/part, selected-page, evidence-byte,
and request-egress budgets cover all sources; they are not reset per document.
Incomplete documents, unexpected structure parts, malformed or extra pages,
oversized structures/evidence, stale/tampered contracts, selection overflow,
and timeouts are normalized and denied.

The adapter reports `logicalEgressBytes`: canonical request bytes sent across
the planned stage boundary plus accepted evidence-text bytes returned. The
injected SDK port does not expose transport telemetry, so this is intentionally
not presented as HTTP wire-byte accounting.

The adapter timeout is fail-closed but cannot cancel a same-process SDK call that
ignores its own transport deadlines. Deployments requiring a hard stop must
isolate that client or supply a transport with cancellation.

## Rejected alternatives

### Build another RAG or index

Rejected. StageFabric governs placement and lineage around retrieval. Index
construction, document parsing, graph extraction, and retrieval-model design
belong behind replaceable adapters.

### Put credentials or SDK module paths in the request

Rejected. A request must not select executable code, endpoints, or credentials.
The composition root registers trusted adapter instances.

### Let an external adapter receive internal or restricted context by convention

Rejected. The effective request classification is the maximum of query and
source classifications. The core planner refuses an external target before the
adapter is invoked.

### Integrate multiple context products in the first slice

Rejected. Graphify, KTX, and other context systems are deliberately absent. A
single narrow external adapter proves the port without turning the slice into a
framework comparison or a new integration monolith.

## Consequences

- Context selection becomes a reviewable, typed execution plan rather than an
  opaque prompt-building helper.
- Existing placement and egress semantics remain the sole authorization source.
- External retrieval remains optional and independently replaceable.
- Quality claims are limited to the checked-in frozen corpus until additional
  real, licensed benchmarks are added.
- PageIndex source/index digests are operator bindings; the current tools API
  does not attest those digests, so they establish configuration integrity, not
  remote service provenance.

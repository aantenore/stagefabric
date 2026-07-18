# Delivery contract: Context Supply Chain vertical slice

- Target release: `v0.6.0-alpha.1`
- Status: implemented for `v0.6.0-alpha.1`

## Outcome

Given a valid `ContextRequest`, StageFabric compiles and executes the strict
sequence `classify -> retrieve -> assemble -> reason`. It emits a digest-bound
`ContextArtifact`, a digest-bound final `ContextRunReceipt`, answer citations,
real input/output accounting, and the existing core execution plan and egress
ledger. `classify` validates and forwards sealed classification metadata in this
slice; semantic classification is a replaceable upstream concern.

The slice supplies context to a reasoning stage. It does not build an index,
manage a knowledge base, upload documents, or implement a generic RAG product.

## Boundary contract

| Boundary           | Trusted                              | Untrusted / validated                              |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Core planning      | Fabric policy, composition root      | request classification, locators, stage graph data |
| Source binding     | operator-created adapter binding     | request source/index locators and digests          |
| External retrieval | registered adapter and page selector | PageIndex status, structure, page response         |
| Assembly           | strict local adapter                 | retrieved evidence and accounting                  |
| Reasoning          | registered reasoner                  | answer and citation list                           |

`ContextRequest` and `ContextArtifact` are available from `stagefabric/core`.
The optional PageIndex adapter is exported only by the default/Node entrypoint.

## Requirements and acceptance evidence

| ID   | Requirement                                                                                                             | Priority | Acceptance evidence                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| CS1  | Request binds classification, freshness, source/index digests, adapter version, budgets, and provenance                 | Must     | contract schema and digest tests                            |
| CS2  | Raw request/artifact verification accepts only canonical sealer form, not reordered recomputed values                   | Must     | permutation and tamper tests                                |
| CS3  | Artifact binds ordered evidence/context, verified context accounting, freshness, plan, and egress lineage               | Must     | ordinal, accounting, integration, and tamper tests          |
| CS4  | Final receipt binds real reasoner output accounting to request, artifact, plan, and egress digests                      | Must     | deterministic run and CLI projection tests                  |
| CS5  | Core plans exactly validate-classification, retrieve, assemble, reason and owns placement/egress                        | Must     | deterministic integration test and CLI projection           |
| CS6  | Freshness uses the execution clock; mixed-offset minimum expiry is selected by epoch and emitted as UTC                 | Must     | stale/future/offset integration tests                       |
| CS7  | Effective classification is the maximum of request and all requested sources                                            | Must     | non-public external-placement rejection test                |
| CS8  | In-process reference path is credential-free, deterministic, and creates no index                                       | Must     | frozen corpus example and repeated-plan test                |
| CS9  | PageIndex is optional, injected, source-bound and globally bounded across at most 64 sources                            | Should   | malformed, fake-clock, 64-source, and aggregate-limit tests |
| CS10 | PageIndex credentials, endpoint, SDK dependency, and dynamic imports are absent from core/config                        | Must     | dependency/package review and adapter constructor contract  |
| CS11 | Benchmark scores exact evidence/fact spans before reasoning and reports tokens, bytes, latency, egress, reproducibility | Must     | ten-case benchmark and order-permutation test               |
| CS12 | Kill gate requires exact safety, same-baseline Pareto, full-context reduction, and reproducibility                      | Must     | checked-in benchmark assertion and `--enforce`              |
| CS13 | Existing demos, browser path, live runner, package exports, and CI remain compatible                                    | Must     | complete `pnpm check` and packed-consumer smoke             |

## Frozen benchmark

`stagefabric-context-corpus-v2` contains three fictional documents, nine
sections, a digest-bound manifest of sixteen exact facts, and ten cases. The
cases cover single-hop lookup, counterfactuals, exclusions, residency traps,
retention, and one multi-hop release question. Full-context reads all sections.
The same-case simple-chunk baseline splits text into fixed eighteen-word chunks
and applies lexical ranking. The Context Supply Chain uses complete source
sections selected by its deterministic reference retriever under the same
per-case context budget.

Scoring inspects selected evidence and assembled context before `reason` runs.
It reports evidence recall/precision, exact fact recall/precision, answer-support
sufficiency, mean/p95 estimated input tokens, bytes, logical egress, and plan/
report reproducibility. Generated answer wording or self-declared citations
cannot improve the score.

The benchmark reports measured wall-clock latency, but does not gate on it.
Machine load makes latency non-reproducible. Quality, input size, egress bytes,
and plan digests are deterministic for the frozen inputs.

The corpus proves only contract wiring and regression behavior. It is not an
independent benchmark of PageIndex, model answer quality, or production recall.
`logicalEgressBytes` is canonical cross-stage request/evidence payload
accounting, not HTTP wire-byte telemetry from an injected SDK.

## Release gate

Before merge:

```bash
pnpm context:demo
pnpm context:benchmark
pnpm context:benchmark:enforce
pnpm check
pnpm build
pnpm pack --dry-run
```

The enforced benchmark must return `killGate.passed: true`; otherwise the
feature remains an explicitly failed spike and must not carry a positive release
claim. Source history and packaged artifacts must also pass the repository
identity and forbidden-literal audit.

## Explicit non-goals

- a vector, tree, graph, or semantic index;
- document upload or lifecycle management;
- Graphify or KTX integration in this slice;
- a bundled PageIndex credential, endpoint, SDK, or page-selection model;
- a claim that the byte-based token estimator equals provider billing tokens;
- authorization based on adapter output instead of the StageFabric plan;
- production claims based only on the synthetic corpus.

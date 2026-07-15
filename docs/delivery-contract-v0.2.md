# Delivery contract: StageFabric v0.2 Live Fabric Runner

- Date: 2026-07-15
- Mode: feature increment in the existing StageFabric repository
- Status: implemented in `v0.2.0-alpha.1`; release evidence pending
- Decision record: [ADR 0002](adr/0002-live-runtime-bindings.md)

## Objective

Turn the deterministic v0.1 placement proof into a safe live execution slice. A
trusted runtime probe must produce current capability evidence, the planner must
bind its decision to that exact runtime configuration, and the executor must run
pure text generation or embedding against an OpenAI-compatible endpoint without
allowing a graph to choose network authority or credentials.

StageFabric remains the application placement and privacy layer above existing
serving systems. It does not replace Ollama, vLLM, Ray Serve LLM, KServe, NVIDIA
Dynamo, llm-d, or their infrastructure responsibilities.

## Scope

### Must

- Keep the v0.1 domain, deterministic planner, lineage, egress proof, and bounded
  executor as the reusable core.
- Add trusted, declarative runtime bindings outside the stage graph.
- Probe configured OpenAI-compatible model availability and seal a fresh
  capability snapshot containing a canonical `bindingDigest`.
- Carry the digest into the execution plan and verify it against the immutable
  adapter registry before stage execution begins.
- Execute configured `generate-text` and `embedding` operations through the
  maintained OpenAI-compatible AI SDK adapter.
- Make endpoint, model, stage operation, logical input, and logical output
  replaceable configuration values with strict schemas.
- Load credential values only from dedicated `STAGEFABRIC_*` environment
  variables at the trusted composition boundary.
- Enforce trusted snapshot time, exact origin/path, HTTPS except loopback HTTP, no
  redirects, abort/deadline, response byte limits, strict response validation,
  safe traces, and `maxRetries: 0`.
- Fail closed before a network call when a binding is absent or its digest differs
  from the planned digest.
- Reject live declassification before network I/O until a trusted output verifier
  exists.
- Preserve the v0.1 public HTTP surface; do not add `POST /runs`.

### Should

- Provide one deterministic contract fixture covering a generation target and an
  embedding target.
- Provide opt-in local smoke commands for Ollama and vLLM using environment-only
  endpoint/credential configuration.
- Keep probe, binding registry, adapter, clock, and fetch boundary behind narrow
  ports so another trusted host can replace them.
- Publish content-free planning and execution reason codes. In this alpha the
  probe deliberately collapses remote detail into an opaque unhealthy target.

### Could

- Record bounded latency observations for later operator analysis without using
  them to silently alter a running plan.
- Add additional OpenAI-compatible serving products to the opt-in smoke matrix
  when an environment is available.

### Out of scope

- tools, function calling, agent actions, or any operation with an external side
  effect;
- streaming, multimodal, reranking, batch requests, arbitrary REST calls, or
  provider-specific extensions;
- adapter retries, redirect following, dynamic executable plugins, or secrets in
  configuration;
- a remote execution endpoint, authentication, authorization, tenants, quotas,
  scheduling API, or workflow state;
- model serving, downloading, sharding, autoscaling, service discovery,
  infrastructure reconciliation, or cluster control;
- externally authenticated snapshots, signing, key distribution, or a
  multi-process trust service.
- live declassification without a trusted output-verification control.

## Assumptions

- The host owns an immutable trusted binding registry for the lifetime of a probe,
  plan, and execution attempt.
- The CLI operator selects the binding registry in a file separate from the graph;
  its unkeyed digest detects mutation but does not establish provenance.
- A configured serving layer exposes compatible models, generation, and/or
  embeddings endpoints; compatibility is verified by contract tests rather than
  inferred from product name.
- The host can inject a trusted wall clock; the runtime provides abort timers for
  I/O deadlines.
- A local Ollama or vLLM smoke endpoint may use literal loopback HTTP. All other
  destinations use HTTPS.
- Credentials, when required, already exist in the process environment and are
  not created, refreshed, or persisted by StageFabric.
- A same-process live snapshot is trusted because the trusted probe created it.
  A digest-valid external snapshot remains untrusted.

## Requirements and acceptance evidence

| ID  | Requirement                               | Priority | Acceptance criteria                                                                                                                                                                               | Verification                                                   |
| --- | ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R1  | Repository and architecture boundary      | Must     | v0.2 extends StageFabric in place and imports no serving control-plane behavior into the domain or planner                                                                                        | Dependency review and architecture test                        |
| R2  | Trusted binding separation                | Must     | Endpoint, model, credential reference, and mappings exist only in an operator-selected binding file; protocol paths stay adapter-owned; placing connection fields in a graph is rejected          | Strict schema and CLI separation tests                         |
| R3  | Configurability without executable config | Must     | Two bindings can change endpoint, model, stage operation, input, and output without source changes; expressions, module paths, callbacks, and arbitrary selectors are impossible                  | Binding codec contract tests                                   |
| R4  | Live capability probe                     | Must     | A bounded models response creates healthy capabilities only when the configured model is present and the binding declares the matching operation                                                  | Mock server integration tests                                  |
| R5  | Placement reacts to reality               | Must     | Removing the configured model from one probe response changes placement to the next eligible target or returns `no_eligible_target` without changing graph code                                   | Deterministic re-plan test                                     |
| R6  | Binding digest continuity                 | Must     | The snapshot and execution plan carry the canonical digest of the non-secret binding used during the probe                                                                                        | Canonicalization and permutation tests                         |
| R7  | Pre-call tamper fence                     | Must     | Changing base URL, model, mapping, limits, or credential reference after planning produces a typed binding mismatch and zero upstream requests                                                    | Spy-fetch integration test                                     |
| R8  | Generation operation                      | Must     | A configured text input produces exactly the configured text output through an OpenAI-compatible adapter with no tool declaration and no extra logical output                                     | Contract mock integration test                                 |
| R9  | Embedding operation                       | Must     | A configured text input produces the exact configured finite vector dimension; malformed, wrong-sized, non-finite, or unexpected output is rejected before publication                            | Contract mock and adversarial tests                            |
| R10 | Network destination policy                | Must     | Non-HTTPS non-loopback origins, user-derived URLs, origin changes, unconfigured paths, query/fragment/dot segments, and redirects are rejected                                                    | SSRF and redirect tests                                        |
| R11 | Bounded execution                         | Must     | Probe and inference calls abort at the configured deadline, consume no more than the response ceiling, and perform no adapter retry                                                               | Fake-clock, slow-body, oversized-body, and request-count tests |
| R12 | Strict failure behavior                   | Must     | Probe failures become an opaque unavailable target; adapter/configuration failures are typed and content-free; no malformed, redirected, timed-out, oversized, or partial output is published     | Failure matrix                                                 |
| R13 | Evidence confidentiality                  | Must     | Traces, safe errors, snapshots, plans, and execution evidence contain no credential, prompt, response, intermediate value, endpoint, body, or raw error text; requested leaf outputs are separate | Sentinel scan over success and every failure path              |
| R14 | Trust statement                           | Must     | Externally supplied digest-valid snapshots cannot authorize live execution without a matching current trusted binding; same-process provenance is documented                                      | Negative integration test and docs review                      |
| R15 | No remote runner                          | Must     | Route inventory and HTTP integration tests prove that `POST /runs` and equivalent execution routes do not exist                                                                                   | HTTP route test                                                |
| R16 | Real runtime smoke                        | Should   | Opt-in smoke succeeds against available Ollama and vLLM deployments for supported operations, with endpoints in trusted bindings and credentials referenced from environment variables            | Manual/opt-in evidence before beta promotion                   |
| R17 | Cross-platform gate                       | Must     | Deterministic, contract, security, type, build, CLI/API regression, and package checks pass on Linux, macOS, and Windows                                                                          | Required CI matrix                                             |
| R18 | No unverified live declassification       | Must     | A live graph declaring any declassification fails before probe or inference; model output alone never lowers classification                                                                       | Secret-sentinel zero-I/O integration test                      |

## Acceptance threshold

The slice is accepted only when all Must requirements pass, all v0.1 regression
tests remain green, and no known P0/P1 defect remains. In particular:

- the live contract mock is mandatory and blocking;
- binding tampering must be rejected before fetch;
- malformed, redirected, timed-out, aborted, oversized, or schema-invalid
  responses must fail closed;
- traces and safe errors must pass sentinel leak scans;
- adapter request count must prove `maxRetries: 0`;
- the platform-independent suite must pass on Linux, macOS, and Windows;
- Ollama and vLLM smoke tests remain opt-in and CI must not depend on a developer
  machine or GPU service. Missing local runtimes may be recorded for an alpha;
  real-runtime evidence is required before beta promotion.

An external snapshot authenticated only by SHA-256 is never sufficient evidence
for release acceptance of live execution.

## Architecture approach

### Components

1. `RuntimeBinding` schema and canonical digest in the trusted adapter/composition
   layer, not in `StageGraph`.
2. A runtime probe adapter that uses a trusted clock and hardened fetch to produce
   target capability observations.
3. Snapshot sealer that adds `bindingDigest` to live target evidence.
4. Existing pure planner extended to consume internal operation availability as
   a restriction that cannot act as a public capability or authority.
5. Executor fence that compares the planned digest with the current trusted
   binding before resolving the adapter call.
6. OpenAI-compatible adapter implemented with `@ai-sdk/openai-compatible` and AI
   SDK `generateText`/embedding primitives, using the injected hardened fetch.
7. Allowlisted trace mapper that discards provider error messages, bodies,
   connection details, and content.

### Configuration boundary

The binding is strict declarative data. Its canonical non-secret fields include:

- binding and target identifiers;
- adapter kind and exact base URL;
- configured model identifier;
- stage-operation to `generate-text`/`embedding` mapping;
- one declared input name and one declared output name per mapping;
- exact expected dimensions for every embedding mapping;
- timeout and maximum response bytes;
- dedicated `STAGEFABRIC_*` environment-variable reference, never its value.

The graph continues to describe dataflow, types, classifications, and capability
requirements only.

Exact protocol paths and zero internal retries are adapter-code invariants, not
binding fields. They change only with a reviewed StageFabric version.

### Failure and fallback semantics

The adapter issues at most one request for an attempt. A transport or provider
failure does not trigger an internal retry. The executor may use a different,
already planned fallback only when the existing pre-output policy permits it and
no value has been published. A digest mismatch is a plan-integrity failure and
must not fall back or re-plan implicitly.

## Proposed test plan

### Critical, blocking

- Strict binding parsing, canonical digest stability, and semantic-change digest
  tests.
- Probe contract tests for model present, model absent, unhealthy response,
  malformed JSON, wrong schema, timeout, abort, redirect, and oversized streaming
  body.
- Planner test proving that a missing model changes placement deterministically.
- Executor test that mutates each binding field after planning and observes zero
  network calls.
- Generation and embedding round trips through a local contract mock using the
  production adapter and hardened fetch.
- Exact-origin/path SSRF tests, including scheme-relative URLs, encoded traversal,
  credentials in authority, query/fragment injection, redirect to another origin,
  and non-loopback HTTP.
- Output tests for extra/missing keys, tool-call variants, non-text generation,
  non-array embeddings, non-finite numbers, excessive dimensions, and partial
  bodies.
- Request-count assertion proving no adapter retry under timeout, `429`, `502`,
  `503`, and `504`.
- Sentinel scan across traces, safe errors, snapshots, plans, and serialized
  results for URL, secret, request content, response content, and raw error text.
- Full v0.1 regression suite and route inventory proving no `POST /runs`.

### Release evidence

- Opt-in Ollama smoke using literal loopback HTTP.
- Opt-in vLLM smoke using literal loopback HTTP or HTTPS.
- `pnpm check`, build, package dry-run, production dependency audit, and demo/CLI
  regression checks.
- Required Linux, macOS, and Windows CI jobs from a clean checkout.

### Deferred and explicitly untested

- GPU throughput, model quality, distributed serving correctness, autoscaling,
  load balancing, and cache behavior: owned by the selected serving layer.
- Remote authenticated execution and tenant isolation: no remote runner exists in
  v0.2.
- Cross-process snapshot authenticity: requires the future signature design.
- Streaming recovery and partial-output replay: streaming is unsupported.

## Security review checklist

- [x] Trusted wall clock controls observation and expiry; bounded abort timers control I/O deadlines.
- [x] HTTP is restricted to literal loopback; all other origins require HTTPS.
- [x] Fetch enforces exact origin and one configured bounded path.
- [x] Redirect mode is `manual`; every `3xx` is rejected and covered by a cross-origin redirect test.
- [x] The body ceiling is enforced during consumption, not only via headers.
- [x] Provider and normalized results cross bounded schemas before use. For
      `/models`, only `data[].id` is authoritative; provider metadata is
      discarded so compatible Ollama, vLLM, and other envelopes remain usable.
- [x] Credential values exist only in dedicated environment-backed composition state.
- [x] `maxRetries` is fixed to zero and verified by request count.
- [x] Trace/error schemas have no URL, secret, content, body, or raw-error fields.
- [x] A matching SHA-256 snapshot digest alone cannot authorize a live call.
- [x] No public execution route has been introduced.
- [x] Live declassification is rejected before I/O without a trusted output verifier.

## Risks and decisions

| Risk or decision                                       | Impact                                                           | Handling                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenAI-compatible implementations differ at the edges  | A nominally compatible runtime can return an unsupported variant | Use maintained provider primitives, strict normalized contracts, and a per-runtime smoke |
| Probe succeeds but inference later fails               | Availability evidence is time-bounded, not a transaction         | Short expiry, deterministic re-plan by the caller, typed failure, no silent mutation     |
| Binding changes after planning                         | Request could reach an unreviewed destination or model           | Pin `bindingDigest` and compare immediately before fetch                                 |
| External snapshot is forged                            | SHA integrity can be mistaken for authorization                  | Same-process live provenance only; future signed snapshot ADR                            |
| Configurable mapping becomes a code-execution language | Security and portability collapse                                | Enumerated operation kinds and exact logical field names only                            |
| Zero retry reduces availability                        | A transient error can fail an attempt                            | Preserve deterministic preplanned fallback semantics; no hidden adapter retry            |
| Endpoint appears in diagnostics                        | Private topology may leak                                        | Digest/reference-only traces and allowlisted safe errors                                 |
| Adding a remote runner expands the threat surface      | Would require identity, tenants, quotas, and abuse controls      | Explicitly exclude `POST /runs` from v0.2                                                |

## Rollout and rollback

The live runner is additive and opt-in. Existing static snapshots and in-process
demo adapters remain the compatibility path. A host enables live behavior only by
registering trusted runtime bindings and the live adapter at its composition root.

Rollback removes that registration and returns to the v0.1 adapters; no graph or
persisted data migration is required. Live bindings must be versioned so an
incompatible future schema fails at startup rather than being interpreted
silently.

## Delivery policy

Implementation and release remain separate gates. This contract records the
acceptance boundary for the alpha; publication still requires atomic Git history,
clean packaging, dependency audit, independent review, and required CI evidence.

## Primary references

- [AI SDK OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers)
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)
- [Ray Serve LLM](https://docs.ray.io/en/latest/serve/llm/index.html)
- [KServe generative inference runtime](https://kserve.github.io/website/docs/model-serving/generative-inference/overview)
- [NVIDIA Dynamo introduction](https://docs.nvidia.com/dynamo/getting-started/introduction)
- [llm-d distributed inference serving stack](https://github.com/llm-d/llm-d)

# Delivery contract: runtime operation qualification gate

- Date: 2026-07-15
- Target release: `v0.3.0-alpha.1`
- Delivery mode: pull request, then prerelease only after required CI is green
- Maturity: alpha; real Ollama/vLLM evidence pending
- Decision record: [ADR 0003](adr/0003-runtime-qualification-gate.md)

## Objective

Prove, with bounded real operation calls, whether explicitly selected runtime
bindings support the declared `configured-wire-shape-v1` generation and embedding
contract. Produce deterministic, content-free evidence suitable for a local or CI
gate without letting that evidence authorize planning or execution. Prompt
content, prompt quality, and model quality are not part of this scope.

## Scope

Must:

- expose provider-independent profile/report evidence and a typed qualification
  request over the current alpha `RuntimeBindings` contract;
- resolve a `RuntimeOperationQualifier` by `provider.kind` at a code-owned
  composition boundary;
- require an explicit, strict profile with target, operation, deadline,
  concurrency, work, and per-generation output-token ceilings;
- reject generation without explicit `maxOutputTokens`, or above the profile
  ceiling, before credential resolution or operation I/O;
- add an opt-in OpenAI-compatible adapter with at most one `/models` call and one
  synthetic call per admitted operation, `maxRetries: 0`, and no redirects;
- preserve configured system-role presence, exact `temperature`, and exact
  admitted `maxOutputTokens` while replacing user and system content with fixed
  synthetic values;
- preserve exact destination/path, response-byte, per-request timeout, total
  deadline, credential, and content-free error boundaries;
- reject missing, throwing, empty, CR/LF-bearing, or over-16-KiB resolved
  credentials before invoking a qualifier;
- bind `configured-wire-shape-v1`, a fixed producer version, and trusted
  registration-supplied qualifier kind/version into the report digest without
  accepting artifact fields from qualifier output;
- make `stagefabric qualify` return a sealed report and nonzero exit status when
  any selected operation is rejected;
- keep reports out of planner, snapshot, and authority inputs.

Out of scope:

- remote qualification APIs, authentication, signing, report provenance, report
  persistence, recurring schedulers, performance or model-quality benchmarks;
- arbitrary prompts, executable configuration, provider-specific scripts,
  streaming, tools, side effects, model downloads, or serving lifecycle control.

## Acceptance matrix

| ID  | Requirement               | Acceptance criteria                                                                                                                                                                                                 | Verification                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Q1  | Strict explicit scope     | Unknown targets/operations, duplicate selections, extra fields, aliases, executable selectors, and work above the declared ceilings fail before provider I/O                                                        | Codec and orchestrator unit tests                                                               |
| Q2  | Exact request budget      | A fully admitted target receives one `/models` request and one request per admitted operation; configuration-rejected generation receives no inference request; no request is retried or redirected                 | Adapter request-count, pre-admission, and CLI tests                                             |
| Q3  | Bounded execution         | Target concurrency never exceeds the profile; each request uses binding timeout/bytes, generation uses an explicit profile token ceiling, and qualifier/credential ports receive one total abort signal             | Concurrency, cooperative-resolver, hanging-adapter, timeout, redirect, and oversized-body tests |
| Q4  | Configured wire shape     | Generation uses synthetic content but exact system-role presence, temperature, and admitted output-token knob, then requires nonempty text/no tool call; embeddings require finite values/configured dimension      | Request-body, admission, and output-contract tests                                              |
| Q5  | Evidence confidentiality  | Serialized report/error contains no endpoint, model, credential, prompt, output value, body, provider payload, or raw error                                                                                         | Sentinel tests over success and failure                                                         |
| Q6  | Determinism and integrity | Selection/completion order does not change evidence; reports omit timestamps and bind the explicit scope, fixed producer, and qualifier registration versions into the digest                                       | Canonicalization, artifact-version, scope, and digest tests                                     |
| Q7  | No planner authority      | Planner and capability snapshot APIs do not import or consume qualification reports                                                                                                                                 | Dependency review and architecture documentation                                                |
| Q8  | CLI gate                  | Passing report exits zero; any rejected operation emits the report then exits one with a content-free error                                                                                                         | Local HTTP CLI integration test                                                                 |
| Q9  | Credential admission      | A referenced credential is nonempty, CR/LF-free, at most 16 KiB UTF-8, and resolved before dispatch; invalid/failing cases reject before qualifier dispatch; a cooperative resolver receives and honors total abort | Resolver matrix, cooperative-abort test, and leak scan                                          |
| Q10 | Versioned producer fence  | Registry caps registrations, validates safe qualifier kind/version, and normalizes duplicate/getter/proxy failures; orchestrator injects registered artifacts and rejects output spoofing                           | Registry adversarial/cap and artifact-spoof tests                                               |
| Q11 | Async evidence integrity  | Qualifiers receive a recursively frozen, least-scope target/operation clone; report identifiers and operation kinds are reconstructed only from a separate private evidence snapshot                                | Mutating-qualifier regression test                                                              |

## Acceptance threshold and rollback

All Q1–Q11 checks and the existing regression suite must pass. Package version and
documentation remain alpha until an opt-in real Ollama or vLLM run succeeds for
the supported operations. Rollback removes the additive command, profile codec,
qualifier registration, and contracts; no stored data or graph migration exists.

## Evidence

- Deterministic scoped contract, version-bound evidence, immutable async
  snapshots, concurrency, deadline, strict config, pre-dispatch credential and
  generation admission, cooperative credential abort, bounded registry, and
  artifact-spoof coverage: implemented.
- OpenAI-compatible exact-call, configured-shape/synthetic-content, missing-model,
  malformed-body, redirect, timeout, oversized-body, raw-error, forged-binding,
  and output-shape coverage: implemented with controlled fetch doubles.
- CLI pass/fail round trip: implemented against a local controlled HTTP server.
- Real Ollama/vLLM smoke: rechecked and skipped on 2026-07-16 because neither
  executable, local endpoint, nor existing Docker image was available; required
  before beta promotion.

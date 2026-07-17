# Delivery contract: Browser Privacy Bridge

- Target release: `v0.5.0-alpha.1`
- Status: implemented for `v0.5.0-alpha.1`
- Scope: local browser redaction, verifiable output lineage, and fail-closed
  authorization before an application-owned egress stage

## Problem

A browser can execute local rules or models, but locality alone does not prove
that sensitive input was removed or that the bytes released later are the bytes
that were checked. Applications also need a way to replace browser inference
runtimes without letting untrusted payload/configuration dynamically import code
or choose a network destination.

The v0.5 slice provides a provider-neutral browser boundary that:

1. validates an operator-owned runtime and policy binding;
2. proves only the coarse browser capabilities needed by that binding;
3. runs bounded redaction in a killable Dedicated Worker;
4. rescans the complete sanitized output;
5. issues a minimized receipt for exact output/policy/binding lineage;
6. releases an egress permit only when every digest and lineage field matches;
7. projects a human-readable plan and content-free execution ledger.

The bridge authorizes output; it does not send output to a cloud or provider.

## Public surface

| Package subpath                    | Contract                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stagefabric/browser`              | Bindings, capability probe, runtime driver registry, Dedicated Worker protocol, redaction cascade, receipt, egress gate, bridge, and projections |
| `stagefabric/browser/transformers` | Optional classifier adapter with an injected Transformers.js-compatible pipeline factory                                                         |
| `stagefabric` / `stagefabric/node` | Existing Node APIs plus the packaged browser-demo server                                                                                         |
| `stagefabric` executable           | `browser-demo` command, loopback host and port configurable                                                                                      |
| `examples/browser-privacy-bridge/` | No-cloud-egress reference application                                                                                                            |

The browser entrypoint must remain free of Node-only imports. Model SDKs,
models, artifact hosts, worker factories, credentials, and downstream network
clients are not part of the browser core contract.

## Execution contract

### 1. Seal deployment policy

`sealBrowserRuntimeBindings` accepts a strict
`BrowserRuntimeBindingsContent` and adds its canonical SHA-256 digest. The
content includes:

- `operatorId`;
- a policy ID, redaction/egress policy IDs and digests;
- the complete redaction rule and classifier ID sets to evaluate;
- capability-probe, readiness, invocation, and cleanup timeouts;
- maximum input and output byte lengths;
- runtime ID, registered driver ID, module-worker URL, and coarse requirements;
- bounded, descriptor-safe JSON runtime configuration.

`verifyBrowserRuntimeBindings` must succeed before request data reaches a
worker. Relative or HTTPS worker URLs are allowed; executable/data/file schemes,
credentials, fragments, traversal, duplicate IDs, and unknown fields are
rejected. Runtime configuration is snapshotted without invoking accessors and
rejects symbols, exotic prototypes, cycles, sparse arrays, reserved keys, and
values outside its depth/node/key/string/array limits. Its cumulative string
budget counts property keys and values. Input and output ceilings are checked
with incremental UTF-8 counters that stop once a ceiling is exceeded. The digest
proves byte-stable content integrity, not provenance or authorization. The
bridge schema-parses into detached data and recursively freezes the full binding
before a target is passed to a registered driver.

### 2. Project plan and probe capabilities

`BrowserPrivacyBridge.execute` accepts safe plan, decision, runtime, and
operation IDs plus input text. The expected rule/classifier IDs are derived only
from the sealed policy binding, not caller input. The bridge checks the input
byte ceiling, selects the exact bound runtime, and creates a deterministic
`BrowserPrivacyPlanProjection` without projecting private runtime configuration.

`probeBrowserCapabilities` reports only:

- secure-context availability;
- whether the WebGPU API can return an adapter;
- whether WebAssembly validates one fixed empty module.

It never reads GPU vendor, architecture, limits, features, timing, user-agent,
or device identifiers. `capabilityProbeTimeoutMs` comes from the sealed operator
policy; a malformed capability result or a probe that does not settle within it
is unavailable. A missing required capability produces a denied ledger and no
Worker invocation.

### 3. Resolve and fence the worker runtime

`BrowserRuntimeDriverRegistry` contains code-registered
`BrowserRuntimeDriver` implementations. Sealed data can name a driver ID but
cannot import driver code. `DedicatedWorkerRuntimeSession` sends the validated
runtime configuration over `stagefabric.dev/browser-worker/v1` and accepts only
strict, request-correlated responses.

Before input is invoked, readiness must return the exact runtime and driver IDs
and advertise the requested operation. Readiness/invocation timeout, abort,
malformed response, native Worker `error`/`messageerror`, and operation mismatch
fail closed through fixed host reason codes; Worker-provided details are not
projected. A timed-out Worker is terminated. Request IDs are never reused for
the lifetime of a session. Each invocation result must echo the exact runtime ID
and operation for its pending request; a delayed duplicate or cross-operation
result is rejected.

The bridge awaits synchronous or asynchronous session cleanup under the sealed
`cleanupTimeoutMs`. Cleanup rejection or timeout denies the transaction as
`execution_failed`; no permit is returned. `DedicatedWorkerPort.terminate` is
mandatory. A native termination exception is normalized and cannot convert a
failed or timed-out exchange into success.

### 4. Redact and verify inside the Dedicated Worker

The worker applies `redactWithCascade` with a
`RedactionCascadePolicy` whose execution boundary is literally
`dedicated-worker`. The policy bounds input code units and total candidate spans
and configures deterministic rules, replacements, priorities, and optional
classifiers. Classifier offsets must be valid UTF-16 boundaries; malformed or
overlapping results cannot bypass deterministic precedence.

`verifyRedactionResult` then reruns the complete rule/classifier policy against
the exact output of a branded cascade result. Any remaining candidate blocks the
transaction. `issuePrivacyDecisionReceipt` accepts only the same-realm
verification handle paired to that exact result, so applied metadata cannot be
substituted from another cascade or rescan. Verification also requires the exact
rule and classifier source sets captured by the cascade to match those evaluated
by the rescan.

Input/candidate limits do not prove an arbitrary regular expression is
ReDoS-safe. The operator owns the regex policy. The Dedicated Worker and host
deadline make that work killable without indefinitely blocking the UI thread.

### 5. Issue a minimized receipt

`PrivacyDecisionReceipt` is strict and canonically digest-bound. It contains:

- decision, plan, runtime, and operation IDs;
- exact browser-binding, redaction-policy, and egress-policy digests;
- exact sanitized-output digest;
- redaction count and sorted category IDs;
- separate sorted rule/classifier ID sets for every source evaluated during the
  complete rescan and for only the sources that produced replacements in the
  paired branded cascade result;
- its own receipt digest.

It must not contain input text, output text, matched text, offsets, model output,
private runtime configuration, or any original-input digest. The output digest
is an integrity/lineage value and is not a confidentiality primitive for
low-entropy output.

### 6. Authorize exact output and project the ledger

`BrowserEgressGate.authorize` verifies receipt structure/digest and compares:

- decision ID, plan ID, runtime ID, and operation;
- browser-binding digest;
- redaction-policy ID and digest;
- the evaluated rule and classifier ID sets against the sealed binding;
- egress-policy ID and digest;
- SHA-256 of the exact output bytes.

Only an exact match returns `BrowserEgressPermit`. Output mutation, stale or
cross-operation receipts, policy/binding mismatch, invalid worker output, limit
overflow, unavailable runtime/capability, and session-close failure all fail
closed. A close failure is normalized as `execution_failed`; no permit is
issued. The permit has an in-realm gate brand: a structural clone may preserve
its fields but is not accepted as proof.

`BrowserPrivacyLedgerProjection` includes only plan/capability/receipt evidence
digests, coarse outcomes, reason codes, and redaction count. It contains no
payload or private runtime configuration. An authorized outcome additionally
requires the gate-branded permit and a strict capability snapshot whose required
flags match the plan, reason codes match availability, and recomputed eligibility
is true.

## Optional Transformers.js classifier

`TransformersSensitiveSpanClassifier` implements `SensitiveSpanClassifier`
without importing Transformers.js. The operator injects a compatible `pipeline`
factory and supplies every runtime choice:

- classifier and model IDs;
- exact model revision as a lowercase 40-character Git commit SHA;
- `token-classification` task;
- `wasm` or `webgpu` device;
- dtype, score threshold, and label-to-category mapping.

The adapter initializes lazily, uses `aggregation_strategy: 'simple'`, validates
every finite score and UTF-16 span, applies the configured threshold/mapping,
normalizes errors, supports cancellation, and disposes the injected pipeline.
It contains no default model, endpoint, credential, artifact host, or implicit
download.

Enabling an external model is an explicit deployment decision. Before doing so,
the operator must approve model/revision and licensing, configure CSP and a
narrow network allowlist for artifact retrieval, define cache/retention policy,
and obtain applicable user or organizational consent. A claim of local
inference does not make the initial model download network-free.

## Reference app contract

The app under `examples/browser-privacy-bridge/` demonstrates the deterministic
rule path with fictional data. It must:

- make no cloud inference or cloud egress;
- use a module Dedicated Worker and the same public bridge contracts;
- require the configured demo module URL to match its statically registered
  Worker factory;
- visualize requested plan, capability decision, redaction receipt, exact-output
  permit, and ledger without rendering the original payload into evidence;
- remain functional without WebGPU or a model download;
- serve on `127.0.0.1:4173` by default through `stagefabric browser-demo`;
- send self-only CSP plus MIME, referrer, and cross-origin hardening headers;
- initialize the Worker through static modules with jitless validation, without
  delaying its message handler behind a dynamic-import bootstrap.

`pnpm browser:dev` is the source-development entrypoint. The packaged CLI serves
the prebuilt static app and performs no remote service discovery.

Browser CI runs the reference app in Chromium, Firefox, and WebKit. The general
CI matrix runs Node.js 24 across Linux, macOS, and Windows and adds Node.js 26 on
Linux.

## Trust boundaries and claims

| Item                                     | Treatment                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| User input                               | Untrusted and size-bounded                                                                                                |
| Worker messages and classifier spans     | Structurally validated and fail closed                                                                                    |
| Sealed bindings                          | Operator-owned integrity contract; not authenticated provenance                                                           |
| Registered driver and worker module      | Trusted deployment code                                                                                                   |
| Regex rules and optional model artifacts | Trusted operator choices; correctness and supply chain remain operator responsibilities                                   |
| Dedicated Worker                         | Concurrency/termination boundary only; not a same-origin security sandbox, hardware enclave, or attested runtime          |
| Receipt and permit                       | Exact output/policy/binding lineage; not proof of semantic completeness, intent, identity, model honesty, or PII coverage |

StageFabric cannot determine whether configured rules/classifiers detect every
sensitive concept. A permit records only that the configured cascade, its paired
complete rescan, and the documented lineage checks completed for the exact
output.

## Requirements and acceptance

| ID   | Requirement                                                                                                                   | Priority | Acceptance evidence                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| BP1  | Strict browser bindings seal canonically, enforce budgets, and are recursively immutable before driver use                    | Must     | Binding and `BrowserPrivacyBridge` unit tests                                     |
| BP2  | Capability probe stays coarse and denies malformed, pending, or unavailable required capabilities                             | Must     | `test/unit/browser-bindings-capability.test.ts`                                   |
| BP3  | Drivers are code-registered, duplicate-safe, and runtime readiness fences exact IDs and operation                             | Must     | Driver-registry, bridge, and worker-protocol unit tests                           |
| BP4  | Worker exchanges bind IDs/operation, require termination, normalize native failures, and bound invocation/cleanup             | Must     | Worker-protocol and `BrowserPrivacyBridge` unit tests                             |
| BP5  | Redaction ordering is deterministic and rejects limits, malformed policy, invalid spans, classifier failure, and cancellation | Must     | `test/unit/browser-privacy-boundary.test.ts`                                      |
| BP6  | Receipt issuance pairs a branded cascade/rescan with identical source provenance                                              | Must     | `test/unit/browser-privacy-boundary.test.ts`                                      |
| BP7  | Receipt takes applied metadata only from that pair and excludes payload, spans, configuration, and original-input digest      | Must     | Receipt assertions in `test/unit/browser-privacy-boundary.test.ts`                |
| BP8  | Egress permit binds exact lineage and carries a non-transferable in-realm gate brand                                          | Must     | Egress-gate, bridge, and explainability unit tests                                |
| BP9  | Authorized ledgers require coherent eligible capabilities and gate-branded proof without payload/configuration                | Must     | `test/unit/browser-explainability.test.ts`                                        |
| BP10 | Transformers adapter stays provider-neutral and requires an immutable 40-character commit SHA plus validated output/disposal  | Should   | `test/unit/transformers-sensitive-span-classifier.test.ts`                        |
| BP11 | Reference app fences its Worker factory, avoids a dynamic-import Worker race, and runs across the browser matrix              | Must     | Browser UI checks and demo-server integration tests                               |
| BP12 | Browser subpaths package without Node imports while Node 24/26 and existing core entrypoints remain compatible                | Must     | CI matrix, typecheck, package smoke, Publint, Are the Types Wrong, and full suite |

## Explicit non-goals

- treating a Dedicated Worker, secure context, WebGPU, or WebAssembly as
  attestation or a hostile-code security boundary;
- proving that a regex/classifier recognizes all PII, secrets, or user intent;
- automatically downloading a model, widening CSP, collecting consent, or
  choosing an artifact host;
- storing the original input or a stable digest of it for analytics;
- owning cloud destinations, credentials, retries, streaming, or downstream
  side effects;
- supporting arbitrary dynamic driver/module imports from user payloads;
- replacing the authenticated Node capability-snapshot path from v0.4.

## Definition of done

- browser bindings, worker protocol, redaction/rescan, receipt, egress gate,
  bridge, explainability projections, and optional injected adapter are exported
  from their documented browser subpaths;
- the reference app builds into the package and launches through both
  `pnpm browser:dev` and `stagefabric browser-demo`;
- deterministic local operation works without credentials, provider calls,
  model downloads, or WebGPU;
- failure paths expose stable content-free reason codes and never release a
  permit;
- unit, integration, browser, package, lint, type, and build gates pass;
- documentation distinguishes integrity/lineage evidence from provenance,
  completeness, isolation, and attestation.

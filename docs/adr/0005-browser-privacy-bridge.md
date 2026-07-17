# ADR 0005: authorize browser egress from verified local redaction

- Status: accepted and implemented
- Target: `v0.5.0-alpha.1`
- Date: 2026-07-17

## Context

Browser applications increasingly run preprocessing and inference locally, but
"ran in the browser" is not an egress policy. An application still needs to
prove which operator policy ran, whether the sanitized result was checked again,
and whether the bytes about to leave the local stage are the bytes that were
approved.

Doing this on the main thread creates a second problem: JavaScript regular
expressions can consume unbounded CPU for a hostile input/pattern combination.
An input-length limit helps but cannot make an arbitrary operator expression
ReDoS-safe. Model-specific code in the core would also couple placement policy
to one SDK, artifact host, device backend, and model revision.

The browser path therefore needs a narrow local execution boundary, strict
operator-owned configuration, provider-neutral runtime ports, and content-free
evidence that can be inspected without retaining the original payload.

## Decision

StageFabric adds a `stagefabric/browser` entrypoint centered on
`BrowserPrivacyBridge`. One execution follows this fail-closed transaction:

```text
verify sealed bindings
  -> project plan
  -> probe coarse browser capabilities
  -> resolve registered driver
  -> initialize Dedicated Worker and verify advertised operation
  -> redact and rescan inside the worker
  -> verify privacy receipt
  -> authorize exact output bytes
  -> project content-free ledger
```

### Operator-owned browser bindings

`BrowserRuntimeBindings` is a strict, canonically hashed contract. It binds the
operator, policy IDs and digests, the complete rule/classifier source set to be
evaluated, `capabilityProbeTimeoutMs`, Worker readiness/invocation timeouts,
`cleanupTimeoutMs`, input/output byte ceilings, and one or more runtime targets.
A target names a provider-neutral `driverId`, a module worker URL, coarse
capability requirements, and JSON configuration. Configuration is captured
through a bounded, descriptor-safe snapshot before schema validation; accessors,
symbols, exotic prototypes, cycles, sparse arrays, reserved keys, and values
outside the structural limits are rejected. One cumulative string budget counts
both property keys and string values. Unsafe worker schemes, path traversal,
duplicate runtime IDs, and unknown schema fields are also rejected. Input and
output checks count UTF-8 incrementally and stop after the operator ceiling is
exceeded. Before driver resolution, the bridge recursively freezes the detached,
schema-parsed binding, including nested target configuration.

The binding digest detects mutation; it does not prove who authored the binding
or attest the worker, driver, model, browser, or device.

### Coarse capability evidence

`probeBrowserCapabilities` reports only secure-context, WebGPU, and WebAssembly
availability with stable reason codes. It deliberately does not collect adapter
vendor, architecture, feature sets, limits, timing, user-agent, or other device
fingerprints. The operator-bound probe timeout turns a pending WebGPU request
into an unavailable outcome; malformed port results also fail closed. An
unavailable required capability blocks execution before Worker invocation.

### Provider-neutral worker execution

`BrowserRuntimeDriver` is the only runtime-specific port. Drivers receive a
validated target binding and return a `BrowserRuntimeSession`; configuration
cannot dynamically import a driver. `DedicatedWorkerRuntimeSession` implements a
strict host-side protocol with unique request IDs, bounded readiness/invocation
deadlines, abort propagation, exact runtime/driver matching, an operation
capability fence, normalized errors, and Worker termination on timeout. Native
Worker `error` and `messageerror` events and Worker-supplied error payloads are
normalized to fixed host outcomes rather than projected verbatim. A request ID
is never reused during the session, and every invocation result must echo the
exact runtime ID and operation associated with its pending request. Session
cleanup is awaited, including asynchronous cleanup, under the operator-bound
`cleanupTimeoutMs`; rejection or timeout becomes `execution_failed` and prevents
permit issuance. Worker ports must implement `terminate`; an ordinary
termination failure is normalized as `worker_failed`, while timeout/error paths
remain denied even if native termination itself throws.

The worker module is deployment code selected by the operator. A Dedicated
Worker moves potentially expensive work off the UI thread and lets the host kill
that work. It is not a security boundary against malicious same-origin code, a
sandbox for untrusted policy, hardware isolation, or attestation.

### Deterministic redaction and mandatory rescan

`redactWithCascade` combines trusted operator regular-expression rules with
optional `SensitiveSpanClassifier` results. Policy fixes input and candidate
limits, replacements, priorities, and the `dedicated-worker` execution boundary.
Overlaps are resolved deterministically by priority, span length, offset, source
ID, and category. Invalid offsets, surrogate-pair splits, malformed policy,
classifier failures, cancellation, and limit overflow fail closed.

After replacement, `verifyRedactionResult` reruns the complete rule and
classifier policy over the output. Receipt issuance accepts only the same-realm
verification handle paired to that exact branded cascade result, and the source
sets captured by cascade and rescan must match exactly. This prevents applied
metadata or source provenance from being substituted from another run. Rules
remain operator-trusted: a pathological expression may run until the host
deadline, but the killable Worker prevents it from indefinitely blocking the
application main thread.

### Receipt and exact-output egress gate

`PrivacyDecisionReceipt` contains:

- decision, plan, runtime, and operation IDs;
- browser-binding, redaction-policy, and egress-policy digests;
- the verified output digest;
- redaction count, the sorted rule/classifier IDs evaluated by the complete
  rescan, and the replacement source/category metadata from its paired branded
  cascade result;
- a canonical receipt digest.

It contains no original input, sanitized output, matched text, span offsets, or
original-input digest. The output digest is necessary to bind authorization to
the exact output bytes. As with any digest of low-entropy data, operators should
treat receipts as access-controlled operational evidence rather than anonymous
telemetry.

`BrowserEgressGate` verifies the receipt digest and compares the exact decision,
plan, runtime, operation, binding, redaction-policy, egress-policy, evaluated
rule/classifier source set, and output digest. Only an exact match returns a
`BrowserEgressPermit`. The permit is branded by that in-realm gate; a structural
clone retains fields but not authorization. The bridge does not perform network
egress; an application may hand the approved output and permit to its own next
stage.

### Explainability projections

The bridge projects a deterministic five-step plan and a content-free ledger.
The ledger records coarse capability evidence, post-output verification,
redaction count, egress outcome, stable reason codes, and evidence digests. It
never projects private runtime configuration or payload text. An authorized
projection additionally requires a gate-branded permit and a structurally valid,
eligible capability snapshot whose requirements and outcomes are coherent with
the plan.

### Optional Transformers.js adapter

`stagefabric/browser/transformers` supplies
`TransformersSensitiveSpanClassifier`, not a bundled provider. The constructor
requires a strict configuration (`classifierId`, model ID, revision, task,
device, dtype, threshold, and label mapping) plus an injected
Transformers.js-compatible `pipeline` factory. Initialization is lazy, spans are
validated, failures are normalized, and disposal is explicit. The revision must
be an immutable lowercase 40-character Git commit SHA; branch names, tags, and
abbreviated SHAs are rejected.

StageFabric imports no model SDK and selects no default model, artifact host, or
endpoint. If an operator enables an external model, its artifact download is a
separate network and privacy decision. The deployment must explicitly configure
the model/revision, CSP and network allowlist, caching/data-retention policy, and
user or organizational consent.

### Reference application

The bundled Browser Privacy Bridge app uses the deterministic local rule path,
serves from loopback by default, and makes no cloud inference or cloud egress.
Its registered demo driver requires the sealed module URL to match the static
Worker factory it constructs. Its server sends a self-only CSP plus cross-origin,
referrer, and MIME hardening headers. It visualizes the plan, capability
decision, receipt, permit, and ledger; it is evidence for the contract, not a
production trust boundary. Its Worker uses static module initialization and
jitless validation, so message handling is not delayed behind a dynamic-import
bootstrap under the strict CSP. CI exercises it in Chromium, Firefox, and
WebKit; the broader CI matrix also includes Node.js 26 on Linux.

## Rejected alternatives

### Run regular expressions on the main thread

Rejected because a pathological rule can freeze the UI and cannot be forcibly
terminated independently of the page.

### Bundle one classifier model and SDK

Rejected because it hardcodes provider, artifact, revision, device, download,
and licensing choices into a policy engine. The injected adapter preserves a
replaceable runtime boundary.

### Hash and retain the original input

Rejected because it is unnecessary for egress authorization and creates a
guessable identifier for low-entropy sensitive data.

### Treat a Dedicated Worker as a security sandbox

Rejected because worker isolation is a concurrency and termination mechanism,
not protection from malicious same-origin application code or a compromised
worker asset.

### Automatically send approved output to a provider

Rejected because the bridge should authorize a boundary, not own application
network destinations, credentials, retries, or downstream side effects.

## Consequences

- Browser privacy decisions become deterministic, bounded, explainable, and
  bound to the exact released output.
- Deployments must register trusted drivers and worker factories in code; sealed
  data can select only among those registrations.
- Capability snapshots and receipts are integrity/lineage evidence, not identity
  proof, semantic correctness, hardware isolation, or attestation.
- Regex policy and worker code remain trusted deployment inputs; the worker
  timeout contains failure but does not make arbitrary expressions safe.
- The deterministic demo needs no model download or external service.
- Optional classifier models add operator-owned download, CSP, consent,
  licensing, storage, and supply-chain responsibilities.

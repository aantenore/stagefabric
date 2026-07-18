# Threat model

## Protected assets

- stage inputs and outputs, especially personal or regulated data;
- adapter credentials and private endpoint addresses;
- policy integrity, capability freshness, and plan reproducibility;
- trace safety and availability under upstream failure.

## Trust boundaries

Browser, local, edge, and cloud are examples, not privileged built-ins. Operators
define arbitrary zones, trust levels, residency, and target capabilities. Every
cross-target or cross-zone dependency is treated as an egress event.

For live execution, the stage graph and provider response are untrusted. The
runtime binding registry, environment, wall clock, composition root, and adapter
code are trusted. The live probe, planner, and executor run in one process against
one parsed, sealed binding value. The CLI obtains that registry from a required,
operator-selected file separate from the graph and resolves only dedicated
`STAGEFABRIC_*` credential variables.

For transported snapshots, the DSSE bundle, statement, snapshot, report, and
caller-supplied paths are untrusted. The deployment-owned trust policy, expected
challenge receipt, wall clock, Sigstore trust root, verifier adapter, and atomic
challenge store are trusted. The signing identity is external to StageFabric;
the process stores no signing key. The reference challenge store is trusted only
as a same-host replay boundary and must be a stable private directory (`0700` on
POSIX) reused across invocations.

## Threats and controls

| Threat                                                            | Control                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw sensitive data leaves an allowed zone                         | Mandatory lineage, hard target eligibility, explicit declassification authority, egress proof tests                                                                 |
| Stale or mutated capability changes placement                     | Expiring snapshots with canonical digest; fail closed on expiry or mismatch; authenticated transport also enforces signed challenge and snapshot time windows       |
| Forged transported snapshot is trusted                            | in-toto predicate inside DSSE; Sigstore v0.3 X.509 bundle verification; exact issuer/identity, certificate/transparency thresholds, audience, and policy digest     |
| Valid signature is mistaken for runtime authority                 | Fixed `placement-evidence-only` ceiling; signed evidence cannot grant public capabilities, declassification, credentials, side effects, or semantic truth           |
| Bundle/evidence changes between plan and run                      | Load/copy once; recursively frozen canonical evidence; verify before planning and again before execution; stable authorization-digest and explicit context checks   |
| Challenge is replayed on one host                                 | Bounded challenge lease plus exclusive digest-keyed marker in a stable private `--challenge-store`, consumed before any credential or provider work                 |
| Runtime binding is swapped after planning                         | Snapshot and plan pin `bindingDigest`; executor compares the immutable adapter registry before stage execution                                                      |
| Async guard mutates a verified plan                               | Executor canonical-clones and recursively freezes the plan before invoking user-supplied asynchronous guards                                                        |
| Availability evidence grants declassification                     | Internal operation evidence is a separate eligibility check; its namespace is rejected in public capabilities and authority declarations                            |
| Model echoes data declared as declassified                        | Alpha live runner rejects every declassification before I/O until a trusted output verifier is available                                                            |
| Config executes attacker code                                     | Strict schemas; no `eval`; no module paths or dynamic imports; registry at composition root                                                                         |
| Graph causes SSRF or destination drift                            | Bindings are outside the graph; canonical request snapshot; HTTPS except loopback HTTP; exact origin/path; query/fragment/redirect rejected                         |
| Oversized or malformed provider response                          | Streaming byte ceiling, deadline/abort, AI SDK schema handling, exact output mapping, and exact finite-vector dimension                                             |
| Secrets or payloads leak to evidence                              | Allowlisted traces/errors and projected execution evidence; requested leaf outputs are returned separately                                                          |
| Duplicate side effects during fallback                            | Retry only before output for an allowlisted failure set; bounded attempts; no replay after partial output or ambiguous timeout                                      |
| Non-deterministic placement evades review                         | Integer metrics, canonical sorting, explicit tie-break, stable digest and permutation tests                                                                         |
| Malicious identifiers forge logs                                  | Identifier schema and structured serialization; no concatenated untrusted log lines                                                                                 |
| Qualification profile triggers unbounded work                     | Explicit existing target/operation selection; target/operation/generation-token ceilings; target worker cap; total deadline; no executable config                   |
| Qualification result becomes runtime authority                    | Report remains isolated from the core planner/executor and grants nothing; authenticated verification accepts it only as exact digest- and scope-bound prerequisite |
| Qualification leaks provider or model content                     | Fixed synthetic user/system content; sealed allowlisted report fields and reason codes; endpoint/model/credential/prompt content/output/raw error omitted           |
| Minimal probe passes an unusable configured call                  | Generation requires explicit bounded output tokens and preserves exact system-role presence, temperature, and token knob; report names the tested wire-shape scope  |
| Missing credential is bypassed by an adapter                      | Orchestrator validates resolver success, nonempty/CRLF-free value, and a 16-KiB UTF-8 ceiling before qualifier dispatch                                             |
| Async qualifier mutates selected evidence                         | Private primitive evidence snapshot; separate recursively frozen least-scope port clone; output reconstructed only against private evidence                         |
| Qualifier output misstates artifact identity                      | Registry validates/snapshots trusted kind/version metadata; orchestrator injects artifacts; output-supplied artifact fields fail closed                             |
| Registry getter/proxy leaks or exhausts work                      | Registration count is capped; construction is guarded; malformed, duplicate, getter, or proxy failures become content-free `qualifier_registry_invalid`             |
| Raw challenge or runtime content reaches a public log             | Statement contains challenge/evidence digests and bounded metadata only; raw challenge, prompts, responses, endpoints, models, and credentials are excluded         |
| Context request selects an arbitrary external document or adapter | Operator source bindings must match source/index locators and digests exactly; adapter code is registered in composition, never imported from request data          |
| Stale or malformed retrieval becomes reasoning authority          | Freshness is checked at sealing and against the execution clock; PageIndex status/structure/pages and evidence digests are bounded and verified during assembly     |
| External retrieval receives non-public context                    | Effective classification is the maximum of query and source classifications; the core planner rejects external placement before adapter invocation                  |
| Citation points outside assembled evidence                        | The reason stage accepts only unique locators present in the verified `ContextArtifact`                                                                             |
| Reordered evidence changes ordinal meaning under a valid digest   | Sealers canonicalize evidence before assigning ordinals; verifiers reject non-canonical raw order even when a caller recomputes the digest                          |
| Multi-source PageIndex work resets limits per document            | One total deadline plus global call, response, structure, page, evidence, and request-egress ceilings cover the full adapter execution                              |
| Logical payload accounting is mistaken for transport telemetry    | The field is explicitly named `logicalEgressBytes`; documentation and receipts do not claim that it measures injected-SDK HTTP framing or headers                   |
| StageFabric becomes a signing-key custodian                       | Statement creation and signing are separate; signing uses an external DSSE/Sigstore client and StageFabric implements verification only                             |

## Residual risk

StageFabric enforces declared metadata, not semantic truth. If an application
labels sensitive input as public, or registers a dishonest adapter, the core
cannot infer intent. Production systems should combine policy review, independent
content controls, transport isolation, and adapter sandboxing.

Runtime bindings are trusted configuration, so the alpha does not resolve and pin
DNS addresses or provide a process-level egress firewall. Hosts that require
protection against DNS rebinding or compromised configuration must enforce
network policy outside the process. Provider leaf output is deliberately returned
as application payload and may contain sensitive content; inputs and intermediate
values are omitted from live execution evidence. The content-free guarantee
applies to plans, snapshots, traces, normalized errors, and evidence—not to
requested model results.

The opt-in qualification gate still consumes provider resources and is not a
performance or model-quality benchmark. Its fixed synthetic user/system content
proves only the named configured wire-shape contract. A standalone report has an
integrity digest but no signer claim. The authenticated workflow can bind that
report into a signed statement as an indirect prerequisite, but the report still
cannot independently authorize placement, declassification, credentials, or
execution.
Reports omit timestamps deliberately: producer and qualifier versions bind
software semantics into a deterministic digest, while execution time belongs to
the external CI or operator record.

Abort is cooperative across extension ports. The built-in qualifier and default
environment resolver honor it, and remote credential resolvers receive the same
signal, but arbitrary same-process code can ignore cancellation and continue
work after the report returns. Hosts requiring a hard stop must isolate adapters
and resolvers in a worker or process they can terminate.

The optional PageIndex adapter applies a total work deadline and aggregate
budgets and stops the StageFabric transaction when any limit is crossed, but the
injected SDK promise has no StageFabric-owned abort contract. It may continue in
the same process after timeout. Hosts needing hard cancellation must isolate the
client or enforce cancellation in its transport. The operator-bound source and
index digests detect request/config drift; the current PageIndex tools response
does not attest those digests or the remote runtime. Its logical egress count is
canonical request plus accepted evidence-text bytes, not actual HTTP wire bytes.

Binding and profile hashes are deterministic correlation identifiers, not
confidentiality controls. A party that already knows most low-entropy
configuration may test guesses offline, so qualification reports should remain
inside the same access boundary as other deployment evidence.

The file challenge consumer provides atomic exclusion only to processes sharing
one filesystem namespace. Deleting, rotating, or replacing `--challenge-store`
for each run erases replay memory, and networked hosts do not coordinate through
it. Clustered deployments must use a durable shared implementation of the same
consumer port. A valid Sigstore bundle authenticates the configured identity and
statement bytes; it does not prove that the probe host, model, runtime, or
provider behaved honestly.

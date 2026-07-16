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

## Threats and controls

| Threat                                           | Control                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raw sensitive data leaves an allowed zone        | Mandatory lineage, hard target eligibility, explicit declassification authority, egress proof tests                                                                |
| Stale or mutated capability changes placement    | Expiring snapshots with canonical digest; fail closed on expiry or mismatch. The live runner accepts only a same-process probe result                              |
| External snapshot is mistaken for authority      | SHA-256 is documented as integrity only; cross-process provenance requires a future signature and trust policy                                                     |
| Runtime binding is swapped after planning        | Snapshot and plan pin `bindingDigest`; executor compares the immutable adapter registry before stage execution                                                     |
| Async guard mutates a verified plan              | Executor canonical-clones and recursively freezes the plan before invoking user-supplied asynchronous guards                                                       |
| Availability evidence grants declassification    | Internal operation evidence is a separate eligibility check; its namespace is rejected in public capabilities and authority declarations                           |
| Model echoes data declared as declassified       | Alpha live runner rejects every declassification before I/O until a trusted output verifier is available                                                           |
| Config executes attacker code                    | Strict schemas; no `eval`; no module paths or dynamic imports; registry at composition root                                                                        |
| Graph causes SSRF or destination drift           | Bindings are outside the graph; canonical request snapshot; HTTPS except loopback HTTP; exact origin/path; query/fragment/redirect rejected                        |
| Oversized or malformed provider response         | Streaming byte ceiling, deadline/abort, AI SDK schema handling, exact output mapping, and exact finite-vector dimension                                            |
| Secrets or payloads leak to evidence             | Allowlisted traces/errors and projected execution evidence; requested leaf outputs are returned separately                                                         |
| Duplicate side effects during fallback           | Retry only before output for an allowlisted failure set; bounded attempts; no replay after partial output or ambiguous timeout                                     |
| Non-deterministic placement evades review        | Integer metrics, canonical sorting, explicit tie-break, stable digest and permutation tests                                                                        |
| Malicious identifiers forge logs                 | Identifier schema and structured serialization; no concatenated untrusted log lines                                                                                |
| Qualification profile triggers unbounded work    | Explicit existing target/operation selection; target/operation/generation-token ceilings; target worker cap; total deadline; no executable config                  |
| Qualification result becomes runtime authority   | Report type is isolated from snapshot/planner/executor inputs; it is documented and tested as release evidence only                                                |
| Qualification leaks provider or model content    | Fixed synthetic user/system content; sealed allowlisted report fields and reason codes; endpoint/model/credential/prompt content/output/raw error omitted          |
| Minimal probe passes an unusable configured call | Generation requires explicit bounded output tokens and preserves exact system-role presence, temperature, and token knob; report names the tested wire-shape scope |
| Missing credential is bypassed by an adapter     | Orchestrator validates resolver success, nonempty/CRLF-free value, and a 16-KiB UTF-8 ceiling before qualifier dispatch                                            |
| Async qualifier mutates selected evidence        | Private primitive evidence snapshot; separate recursively frozen least-scope port clone; output reconstructed only against private evidence                        |
| Qualifier output misstates artifact identity     | Registry validates/snapshots trusted kind/version metadata; orchestrator injects artifacts; output-supplied artifact fields fail closed                            |
| Registry getter/proxy leaks or exhausts work     | Registration count is capped; construction is guarded; malformed, duplicate, getter, or proxy failures become content-free `qualifier_registry_invalid`            |

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
proves only the named configured wire-shape contract. Reports have an integrity
digest but no signature or provenance claim, and cannot authorize placement or
execution.
Reports omit timestamps deliberately: producer and qualifier versions bind
software semantics into a deterministic digest, while execution time belongs to
the external CI or operator record.

Abort is cooperative across extension ports. The built-in qualifier and default
environment resolver honor it, and remote credential resolvers receive the same
signal, but arbitrary same-process code can ignore cancellation and continue
work after the report returns. Hosts requiring a hard stop must isolate adapters
and resolvers in a worker or process they can terminate.

Binding and profile hashes are deterministic correlation identifiers, not
confidentiality controls. A party that already knows most low-entropy
configuration may test guesses offline, so qualification reports should remain
inside the same access boundary as other deployment evidence.

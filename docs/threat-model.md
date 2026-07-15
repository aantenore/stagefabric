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

| Threat                                        | Control                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw sensitive data leaves an allowed zone     | Mandatory lineage, hard target eligibility, explicit declassification authority, egress proof tests                                         |
| Stale or mutated capability changes placement | Expiring snapshots with canonical digest; fail closed on expiry or mismatch. The live runner accepts only a same-process probe result       |
| External snapshot is mistaken for authority   | SHA-256 is documented as integrity only; cross-process provenance requires a future signature and trust policy                              |
| Runtime binding is swapped after planning     | Snapshot and plan pin `bindingDigest`; executor compares the immutable adapter registry before stage execution                              |
| Async guard mutates a verified plan           | Executor canonical-clones and recursively freezes the plan before invoking user-supplied asynchronous guards                                |
| Availability evidence grants declassification | Internal operation evidence is a separate eligibility check; its namespace is rejected in public capabilities and authority declarations    |
| Model echoes data declared as declassified    | Alpha live runner rejects every declassification before I/O until a trusted output verifier is available                                    |
| Config executes attacker code                 | Strict schemas; no `eval`; no module paths or dynamic imports; registry at composition root                                                 |
| Graph causes SSRF or destination drift        | Bindings are outside the graph; canonical request snapshot; HTTPS except loopback HTTP; exact origin/path; query/fragment/redirect rejected |
| Oversized or malformed provider response      | Streaming byte ceiling, deadline/abort, AI SDK schema handling, exact output mapping, and exact finite-vector dimension                     |
| Secrets or payloads leak to evidence          | Allowlisted traces/errors and projected execution evidence; requested leaf outputs are returned separately                                  |
| Duplicate side effects during fallback        | Retry only before output for an allowlisted failure set; bounded attempts; no replay after partial output or ambiguous timeout              |
| Non-deterministic placement evades review     | Integer metrics, canonical sorting, explicit tie-break, stable digest and permutation tests                                                 |
| Malicious identifiers forge logs              | Identifier schema and structured serialization; no concatenated untrusted log lines                                                         |

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

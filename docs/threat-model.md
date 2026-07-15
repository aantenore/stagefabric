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

## Threats and controls

| Threat                                       | Control                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Raw sensitive data leaves an allowed zone    | Mandatory lineage, hard target eligibility, explicit declassification authority, egress proof tests                            |
| Stale or forged capability changes placement | Expiring snapshots with canonical digest; fail closed on expiry or mismatch                                                    |
| Config executes attacker code                | Strict schemas; no `eval`; no module paths or dynamic imports; registry at composition root                                    |
| SSRF through endpoint configuration          | Core never fetches endpoints; production adapters must use scheme/host allowlists and resolved-IP checks                       |
| Secrets or payloads leak to logs             | Allowlisted trace schema containing metadata and reason codes only                                                             |
| Duplicate side effects during fallback       | Retry only before output for an allowlisted failure set; bounded attempts; no replay after partial output or ambiguous timeout |
| Non-deterministic placement evades review    | Integer metrics, canonical sorting, explicit tie-break, stable digest and permutation tests                                    |
| Malicious identifiers forge logs             | Identifier schema and structured serialization; no concatenated untrusted log lines                                            |

## Residual risk

StageFabric enforces declared metadata, not semantic truth. If an application
labels sensitive input as public, or registers a dishonest adapter, the core
cannot infer intent. Production systems should combine policy review, independent
content controls, transport isolation, and adapter sandboxing.

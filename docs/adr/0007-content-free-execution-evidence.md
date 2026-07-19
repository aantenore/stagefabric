# ADR 0007: project successful live runs into content-free observation evidence

- Status: accepted and implemented
- Target: `v0.7.0-alpha.1`
- Date: 2026-07-19

## Context

An enterprise orchestrator, conformance engine, or project-lineage system needs
to bind a host run to the plan and placements that StageFabric actually used.
`LiveRunResult` is intentionally an application-facing object: it includes leaf
outputs and raw stage, target, and zone identifiers. Persisting it as evidence
would widen the disclosure boundary and make downstream systems appear more
authoritative than they are.

The existing executor already returns a bounded content-free trace, but its raw
identifiers can expose deployment topology. Hashing model output would be worse:
it would create a stable confirmation oracle for sensitive or low-entropy
content. Evidence must therefore bind execution placement without retaining
application/provider content or acquiring execution authority.

## Decision

StageFabric defines strict `ExecutionPlacementEvidence` with media type
`application/vnd.stagefabric.execution-placement-evidence+json`.

The artifact fixes:

- `apiVersion: stagefabric.dev/v1alpha1` and
  `kind: ExecutionPlacementEvidence`;
- `producer: stagefabric`;
- `disclosure: content-free`;
- `authority: observation-only`.

It canonical-hashes a bounded host-provided run identifier and binds a host
observation timestamp plus the successful result's plan, runtime-binding,
capability-snapshot, and egress-ledger digests. Placement and trace entries keep
only canonical SHA-256 digests of stage, target, zone, and adapter-kind
identifiers. Attempts, outcome, allowlisted reason code, and the bounded HTTP
status used for a retryable pre-output failure are the only non-digest execution
metadata. A canonical top-level SHA-256 seals the artifact.

The composition creator validates that:

1. the plan and capability snapshot remain correctly sealed;
2. plan, binding, snapshot, egress, and execution digests agree;
3. every trace attempt selects the exact planned primary/fallback ordinal;
4. every successful stage has exactly one completed placement;
5. trace order, attempts, statuses, reason codes, and sizes remain bounded.

The creator accepts a successful `LiveRunResult`, not a generic execution event
stream. It never reads inputs, outputs, output hashes, models, endpoints,
credentials, or raw provider errors. This is an after-success projection; the
unchanged executor has no new callback or observer failure mode.

The CLI exposes the projection only when both `--evidence-run-id` and
`--evidence-output` are present. It validates the pair before provider work,
creates the evidence path only after successful execution, opens the final path
with `O_NOFOLLOW|O_EXCL` and mode `0600`, fsyncs the file, and never replaces an
existing path. Stdout adds only `{digest, path}` metadata for the artifact.

## Authority ceiling

The evidence describes what StageFabric observed after a successful run. It
cannot authorize that run retroactively or prospectively. The planner, executor,
credential resolver, declassification verifier, and capability model never
consume the artifact. Downstream adapters must preserve the
`observation-only` ceiling and cannot convert the artifact into an authority
grant, approval, declassification permit, semantic-quality claim, or provider
attestation.

The top-level digest detects mutation but does not authenticate a producer. A
host may bind the exact artifact bytes into an external DSSE/Sigstore or other
attestation workflow without adding signing keys to StageFabric.

## Rejected alternatives

### Persist `LiveRunResult`

Rejected. It contains application outputs and raw deployment identifiers.

### Retain input or output hashes

Rejected. Content-derived hashes can confirm guesses about low-entropy or known
payloads and are unnecessary for placement lineage.

### Emit evidence incrementally from the executor

Rejected for this slice. An observer introduces another in-execution failure and
mutation boundary. The successful result already contains the bounded placement
and trace projection required by this contract.

### Treat the artifact digest as a signature

Rejected. Integrity, producer authentication, runtime attestation, and authority
are distinct concerns. Authenticity remains an external host responsibility.

## Consequences

- StageFabric can participate in external run lineage without persisting model or
  application content.
- Raw placement identifiers are pseudonymized, not encrypted; low-entropy values
  remain guessable and evidence still requires access control.
- A failed run produces no success artifact in the CLI. Failure evidence, if ever
  added, requires a distinct kind and semantics rather than weakening this one.
- The reference writer protects the final path component. Operators remain
  responsible for a trusted private parent directory and distributed storage.

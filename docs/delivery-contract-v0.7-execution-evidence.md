# Delivery contract: content-free execution placement evidence

- Target release: `v0.7.0-alpha.1`
- Status: implemented for `v0.7.0-alpha.1`

## Outcome

After a successful live run, an operator may request one strict, sealed
`ExecutionPlacementEvidence` artifact that correlates an external host run with
the StageFabric plan, binding, snapshot, egress ledger, selected placements, and
bounded execution trace without persisting application/provider content or raw
topology identifiers.

The artifact is observation-only. It does not add a generic event stream,
failure artifact, signing service, runtime attestation, or authorization path.

## Boundary contract

| Boundary           | Trusted                                    | Untrusted / validated                         |
| ------------------ | ------------------------------------------ | --------------------------------------------- |
| Projection input   | successful `LiveRunResult`, host clock     | host run ID                                   |
| Runtime coherence  | sealed StageFabric algorithms              | result structure and cross-digest consistency |
| Persistence        | writer implementation                      | output path and existing final entry          |
| Downstream lineage | independently configured consumer/attestor | evidence bytes and claimed producer           |

The domain schema, parser, verifier, digest computer, and sealer are available
from `stagefabric/core`. The creator is exported by the default/Node entrypoint
because it consumes `LiveRunResult`; the filesystem writer is Node-only.

## Requirements and acceptance evidence

| ID   | Requirement                                                                                                 | Priority | Acceptance evidence                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------- |
| EP1  | Fixed API/kind/producer/disclosure/authority and strict unknown-field rejection                             | Must     | schema/parser unit tests                                |
| EP2  | Host run ID is retained only as canonical SHA-256 and changing it changes the evidence digest               | Must     | correlation-digest tests                                |
| EP3  | Plan, binding, snapshot, and egress digests agree with one coherent successful live result                  | Must     | creator coherence and tamper tests                      |
| EP4  | Raw stage/target/zone/adapter IDs are replaced by canonical digests; attempts/status/reasons are bounded    | Must     | projection and adversarial schema tests                 |
| EP5  | Inputs, outputs, content-derived hashes, models, endpoints, credentials, and raw provider errors are absent | Must     | explicit sentinel and negative-hash tests               |
| EP6  | Top-level canonical digest is verified by the exported parser                                               | Must     | mutation and parser tests                               |
| EP7  | CLI evidence flags are an all-or-nothing pair validated before live provider work                           | Must     | paired-option integration tests                         |
| EP8  | Final output uses `O_NOFOLLOW` and `O_EXCL`, never clobbers, and is private (`0600`) on POSIX               | Must     | file adapter, existing-path, symlink, and mode tests    |
| EP9  | Failed execution creates no evidence path and persistence failure emits no normal run output                | Must     | live failure and no-clobber integration tests           |
| EP10 | Normal CLI JSON exposes only evidence digest/path metadata rather than artifact contents or raw host run ID | Must     | CLI projection integration test                         |
| EP11 | Existing live, authenticated, browser, context, package, and cross-platform behavior remain compatible      | Must     | full `pnpm check`, build, package, and browser CI gates |

## Release gate

Before merge:

```bash
pnpm check
pnpm build
pnpm pack --dry-run
```

The exact diff and commit metadata must also pass the repository identity and
forbidden-literal audit. No release claim is valid if the full regression or
package-consumer smoke fails.

## Explicit non-goals

- failure or partial-run evidence under the successful artifact kind;
- raw run, stage, target, zone, adapter, model, endpoint, credential, input, or
  output retention;
- input/output content hashes;
- producer authentication, signing-key custody, or runtime attestation;
- granting placement, capability, approval, declassification, credential,
  side-effect, or execution authority;
- replacing a durable distributed evidence store.

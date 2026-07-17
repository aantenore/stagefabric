# Changelog

All notable changes to StageFabric are documented in this file.

## [0.5.0-alpha.1] - 2026-07-17

### Added

- Provider-neutral Browser Privacy Bridge with sealed operator bindings, coarse
  secure-context/WebGPU/WebAssembly capability checks, code-registered drivers,
  and a strict Dedicated Worker protocol.
- Deterministic, bounded rule/classifier redaction cascade with a mandatory
  complete post-output rescan before receipt issuance.
- Minimized privacy receipt, exact-output egress permit, and deterministic plan
  and ledger projections. Receipts retain output/policy/binding lineage but no
  raw input, raw output, matched text, or original-input digest.
- Optional Transformers.js-compatible sensitive-span classifier adapter with an
  injected pipeline factory and fully operator-supplied model/runtime
  configuration.
- No-cloud-egress Browser Privacy Bridge reference app, available during
  development with `pnpm browser:dev` and from the packaged CLI with
  `stagefabric browser-demo`.
- Browser-specific package subpaths: `stagefabric/browser` and
  `stagefabric/browser/transformers`.

### Changed

- The executor now snapshots plain execution data before every guard, adapter,
  fallback, and output-verifier call so one extension cannot mutate caller data
  or influence a later attempt.
- Every declassified output now requires an explicit `StageOutputVerifier` to
  return exactly `true`; missing, failed, or rejected verification produces the
  fail-closed `output_policy_rejected` result.
- Package builds clean stale output, embed original sources in JavaScript source
  maps, derive the CLI version from package metadata, and smoke-test a packed
  consumer rather than the workspace checkout.
- Browser policy bindings now own the evaluated rule/classifier source set and
  operator-selected capability/cleanup timeouts and byte ceilings. Runtime
  configuration passes through a descriptor-safe JSON snapshot with a
  cumulative property-key/value string budget; input/output UTF-8 counting
  stops at the configured ceiling. Parsed bindings are recursively frozen before
  any selected target reaches a driver.
- Privacy receipts distinguish every evaluated redaction source from the subset
  that produced replacements. Applied metadata must come from the same branded
  cascade result and complete rescan pair with an identical evaluated source
  set. Egress permits now also bind the decision ID and evaluated source set.
- Egress permits carry an in-realm gate brand that does not transfer to a
  structural clone. Authorized ledgers require that brand plus an eligible,
  plan-coherent capability snapshot.
- Dedicated Worker sessions never reuse request IDs, require invocation results
  to echo the exact runtime and operation, normalize native `error`/
  `messageerror` events, require a termination port, and await asynchronous
  cleanup under a bounded timeout. Native termination failures are normalized.
- Malformed or pending capability probes fail closed under the operator-bound
  probe timeout. The demo driver accepts only the module URL corresponding to
  its registered Worker factory.
- The reference Worker uses static module initialization with jitless validation
  instead of deferring message handling behind a dynamic-import bootstrap under
  its strict CSP.
- The optional Transformers-compatible adapter now accepts only immutable model
  revisions expressed as lowercase 40-character Git commit SHAs.
- Browser CI now runs Chromium, Firefox, and WebKit; the Node matrix also covers
  Node.js 26 on Linux.

### Security

- Regular-expression work is bounded by policy and runs in a host-terminable
  Dedicated Worker. The worker is a concurrency/termination boundary, not a
  security sandbox, hardware isolation, or runtime/model attestation.
- External classifier-model downloads remain opt-in and require explicit
  operator model configuration, CSP/network policy, and applicable consent.
- `SensitiveDataGuard` rejects accessors, symbol keys, exotic prototypes,
  cycles, and inspection limits instead of traversing ambiguous values. It scans
  string property keys as well as values, with UTF-8 inspection bounded by the
  configured byte ceiling.
- Adapter, input-policy, and output-verifier error metadata is branded, frozen,
  and restricted to fixed code sets; forged or unexpected runtime details are
  normalized before entering traces.

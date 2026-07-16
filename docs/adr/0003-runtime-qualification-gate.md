# ADR 0003: bounded runtime operation qualification gate

- Status: accepted for the next alpha increment
- Date: 2026-07-15

## Context

`GET /models` proves that a server advertises an identifier; it does not prove
that the configured generation model has a usable chat template, that an
embedding endpoint returns the declared dimensions, or that the exact operation
mapping works. Treating discovery as compatibility evidence is therefore too
weak for release qualification.

Qualification also creates network traffic and may consume inference resources.
It must be explicit and bounded, and its output must not become an alternate path
for granting placement or declassification authority.

## Decision

StageFabric adds an opt-in `stagefabric qualify` control-plane command in this
repository. A strict `RuntimeQualificationProfile` explicitly selects existing
binding target/operation pairs and declares total deadline, concurrency, target,
operation, and per-generation output-token ceilings. It cannot contain prompts,
code, module paths, callbacks, wire paths, endpoints, models, or credentials.

The application layer resolves a `RuntimeOperationQualifier` from a code-owned
registry keyed by `provider.kind`. Registry admission is capped and snapshots a
safe registration-supplied `kind`, implementation `version`, and callable method;
duplicate, malformed, getter, or proxy failures collapse to
`qualifier_registry_invalid`. These values are trusted composition metadata, not
code provenance. The current alpha binding schema and first adapter support
`openai-compatible` version `1`. For each admitted target it performs:

1. exactly one bounded `GET /models` request;
2. exactly one non-streaming, internally fixed synthetic request for every
   admitted generation or embedding operation;
3. zero retries and zero redirect following.

Generation is admitted only when the binding declares `maxOutputTokens` at or
below the profile ceiling. Missing or excessive values become
`operation_configuration_unqualified` before credential resolution or operation
I/O. An admitted generation uses fixed synthetic user content and, iff the
binding has a system prompt, fixed synthetic system content. It preserves exact
system-role presence, `temperature`, and `maxOutputTokens`; it does not test the
real prompt's content, length, or quality. Embedding uses fixed synthetic input
and verifies the configured output dimension.

Requests use the existing exact-origin/path fetch boundary, per-request timeout,
response byte ceiling, environment-backed credential resolution, and the
orchestrator's total abort signal. When a binding references a credential, the
orchestrator requires the resolver to return a nonempty, CR/LF-free UTF-8 string
no larger than 16 KiB before invoking any qualifier. Missing, throwing, empty,
malformed, or oversized resolution becomes `credential_unavailable`. Credential
resolvers receive the total signal so cooperative remote lookups can cancel.
Operations within one target are sequential; target workers are capped by
`maxConcurrency`.

Before asynchronous extension code runs, the orchestrator creates a private
primitive evidence snapshot and a separate recursively frozen, selected-operation
target clone. Qualifier output is validated and reconstructed against the private
snapshot, never against an object that crossed the async port.

The sealed `RuntimeQualificationReport` contains only
`qualificationScope: configured-wire-shape-v1`, binding/profile digests, a fixed
producer artifact `{id: stagefabric-runtime-qualification, version: 1}`, target
and operation identifiers, operation kind, status, stable reason codes, and the
trusted registration's qualifier `{kind, version}` (`null` only when no qualifier
is registered). Qualifier output cannot supply or override that artifact. The
report contains no endpoint, model, credential, prompt content, completion,
embedding, response body, status payload, or raw exception. Completion order does
not affect result order or digest.

The report intentionally contains no timestamp. Producer and qualifier versions
bind the evidence semantics into the deterministic digest without introducing a
clock-dependent value; a CI system may record run time outside the report. These
versions identify software artifacts, not signer identity or provenance.

Qualification reports are release/CI evidence only. The planner, capability
snapshot, executor, and declassification rules do not accept them as input. A
successful report grants no runtime authority and does not extend snapshot
freshness.

## Consequences

- Operator cost is visible and bounded by an explicit profile.
- Provider adapters remain replaceable at the code-owned port. Supporting a new
  provider kind also requires an explicit trusted binding-schema release.
- Credential failure cannot be overridden by a permissive provider adapter.
- Producer and qualifier versions make evidence semantics reviewable while
  preserving deterministic report bytes.
- A nominally advertised but unusable operation fails before beta promotion.
- Synthetic content cannot validate the configured prompt's semantics, length,
  moderation behavior, or quality; those remain outside this compatibility gate.
- A non-cooperative custom credential resolver or qualifier can outlive the
  returned deadline even though its result is ignored; cancellation is a trusted
  port obligation and process isolation remains a host concern.
- Signed reports, remote qualification services, schedulers, performance
  benchmarks, and recurring background runs remain out of scope.

## Evidence status

Contract-mock unit and CLI integration coverage is implemented. The environment
was rechecked on 2026-07-16: neither `ollama` nor `vllm`, a compatible local
endpoint, or an existing runtime Docker image was available, so the real-runtime
smoke was skipped. This evidence is sufficient for an alpha slice, not for beta
promotion.

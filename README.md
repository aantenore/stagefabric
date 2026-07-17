# StageFabric

**Policy-driven placement for hybrid AI pipelines.**

StageFabric compiles a typed AI stage graph into an explainable execution plan
across browser, local, edge, and cloud targets. Privacy constraints are hard
placement rules: data cannot cross a boundary unless the plan contains a valid,
auditable egress decision.

```text
classify@browser -> redact@browser -> embed@local -> retrieve@edge -> reason@cloud
```

It is not a model server, a tensor-sharding runtime, or another request-level LLM
router. StageFabric works one level above those systems and keeps target adapters
replaceable.

## Why it exists

Modern runtimes can execute AI in browsers, on laptops, at the edge, and in GPU
clusters. Existing routers generally choose one model for one request; serving
systems place infrastructure. Applications still need to decide where each stage
may run and prove what crossed every trust boundary.

StageFabric makes that decision deterministic and testable:

- typed DAG validation and stable topological planning;
- classification lineage with explicit, capability-gated declassification;
- configurable zones, trust levels, residency, capabilities, latency, and cost;
- ordered per-stage fallbacks and reason-coded candidate rejection;
- an egress ledger and content-free execution traces;
- adapters registered in code, never imported from untrusted configuration.

## Status

StageFabric is an experimental `v0.4.0-alpha.1` reference implementation. Its
planner is deliberately deterministic and greedy, not a globally optimal
scheduler. The original in-process demo remains reproducible without credentials
or model downloads. The opt-in Live Fabric Runner now probes and executes real
OpenAI-compatible runtimes while keeping endpoints, models, and credentials out
of the stage graph. A separate authenticated path can transport a capability
snapshot across processes, verify its signer and bounded evidence, compile a
reviewable plan, and consume a single-use challenge before execution.

## Quick start

Requires [Node.js 24.15.0](https://nodejs.org/en/blog/release/v24.15.0) or newer
within 24.x, or Node.js 26+ (`^24.15.0 || >=26.0.0`), plus pnpm 11+. Node.js 25
is intentionally outside the supported engine range.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm stagefabric demo
```

Other commands:

```bash
pnpm stagefabric validate examples/stagefabric.yaml
pnpm stagefabric plan examples/stagefabric.yaml
pnpm stagefabric run examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml
pnpm stagefabric qualify \
  --bindings examples/runtime-bindings.ollama.yaml \
  --profile examples/runtime-qualification.ollama.yaml
pnpm stagefabric challenge issue --help
pnpm stagefabric observe --help
pnpm stagefabric trust-policy create --help
pnpm stagefabric attestation-statement --help
pnpm stagefabric plan-authenticated --help
pnpm stagefabric run-authenticated --help
pnpm stagefabric serve --host 127.0.0.1 --port 8787
```

The HTTP service exposes `GET /healthz`, `POST /v1/plans`, and
`POST /v1/demo/runs`. It binds to loopback by default. Live execution is CLI and
library only; this release deliberately adds no remotely invokable run endpoint.

## Live Fabric Runner

The live path is a single fail-closed transaction:

```text
trusted runtime bindings -> live model probe -> fresh capability snapshot
                         -> deterministic plan -> binding fence -> execution
```

Runtime bindings are strict declarative data. They map a trusted `targetId` and
stage operation to an OpenAI-compatible base URL, model, one logical input, and
one logical output. A credential can only be referenced by environment-variable
name prefixed with `STAGEFABRIC_`; its value never enters configuration,
snapshots, plans, or traces. The CLI requires the operator-owned bindings as a
separate `--bindings` file, so an application graph cannot select a destination
or process credential. The digest detects mutation; it does not establish
provenance.

The checked-in example targets a local Ollama endpoint and exercises both text
generation and embedding. Pull the configured models and start Ollama first:

```bash
ollama pull nomic-embed-text
ollama pull qwen3:4b
ollama serve
pnpm stagefabric run examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml
```

Change the endpoint, model IDs, operation names, input/output ports, expected
embedding dimension, limits, and optional credential reference in the trusted
bindings YAML without changing source code. HTTPS is required except for literal
loopback/localhost HTTP. The runner refuses redirects, cross-origin/path requests,
stale or tampered bindings, oversized responses, malformed provider output,
ambiguous retry, and models absent from the fresh `/models` observation.

Only non-streaming `generate-text` and `embedding` are admitted in this alpha.
Live declassification is rejected until a trusted output verifier can prove that
a provider response no longer contains the protected input. Core planning still
supports explicit declassification for hosts that supply such controls. Tools,
side effects, arbitrary HTTP, and public remote execution are explicit non-goals.

### Runtime qualification gate

`stagefabric qualify` is an opt-in compatibility gate for the exact operations
selected in a strict `RuntimeQualificationProfile`. Generation is admitted only
when the binding declares `maxOutputTokens` no greater than the profile's
`maxGenerationOutputTokensPerCall`; otherwise it becomes
`operation_configuration_unqualified` before credential resolution or inference
I/O. After admission, each target makes one bounded `/models` request and one
non-streaming synthetic call per admitted operation. It performs no retry,
refuses redirects, applies the binding's per-request timeout and response ceiling,
and caps total deadline and target concurrency from the profile.

The gate qualifies `configured-wire-shape-v1`, not prompt quality or application
semantics. Generation sends fixed synthetic user content; when a binding has a
system prompt it sends a fixed synthetic system instruction instead of the real
content. System-role presence, `temperature`, and the admitted
`maxOutputTokens` value match the binding exactly. Embedding uses fixed synthetic
input and verifies finite values with the configured dimension. Tools, streaming,
and retries remain disabled. If a selected binding references a credential, the
orchestrator rejects a missing/failing resolver, empty or CR/LF-bearing value, or
more than 16 KiB of UTF-8 before any qualifier call. Custom credential resolvers
also receive the total abort signal and should cancel their underlying I/O.

The resulting sealed report contains only the explicit qualification scope,
digests, a fixed producer version, target/operation identifiers, status, reason
codes, and the registration-supplied qualifier kind/version (`null` when
unavailable). Qualifier output cannot override those artifacts; they identify
trusted registration metadata, not code provenance. The report intentionally has
no timestamp: artifact versions bind its semantics while the bytes and digest
remain deterministic. It never contains endpoints, models, credentials, prompt
content, outputs, response bodies, or raw errors. A report is CI/release evidence
only: the planner, snapshot, executor, and declassification rules never consume it
as authority. The checked-in profile is explicit so merely adding a binding
cannot start inference work.

The real-runtime gate and live graph were rerun successfully on 2026-07-17 with
[Ollama 0.32.1](https://github.com/ollama/ollama/releases/tag/v0.32.1),
`nomic-embed-text:latest`, and `qwen3:4b`: embedding and generation qualified,
both live stages completed, and the expected 768-dimensional embedding was
observed. Only digests, dimensions, output length, and status were retained; see
the [content-free qualification evidence](docs/evidence/ollama-qualification-2026-07-17.md).
This closes the alpha evidence target, not the broader beta bar for multiple
runtimes and operating systems.

## Authenticated transported snapshots

`v0.4.0-alpha.1` adds a fail-closed control-plane path around the unchanged core
planner. Its signed payload follows [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md);
[DSSE](https://github.com/secure-systems-lab/dsse) authenticates the payload type
and bytes, while Sigstore supplies identity and transparency evidence. Signing is
deliberately external: StageFabric stores no private key and implements no custom
cryptography. The pinned command below uses the official
[`@sigstore/cli` 0.10.1](https://www.npmjs.com/package/@sigstore/cli).

The operator generates a deployment-specific trust policy whose derived
fabric/profile digests, audience, certificate issuer, and exact signer identity
match the environment. Qualification and policy generation happen before the
short-lived challenge is opened. One reproducible workflow is:

```bash
EVIDENCE=.stagefabric/evidence
CHALLENGE_STORE=.stagefabric/challenge-store
TRUST_POLICY="$EVIDENCE/trust-policy.json"
AUDIENCE=stagefabric:production-control-plane
SIGSTORE_CERTIFICATE_ISSUER=https://oauth2.sigstore.dev/auth
SIGSTORE_IDENTITY_EMAIL=operator@example.com
mkdir -p "$EVIDENCE" "$CHALLENGE_STORE"
chmod 700 "$CHALLENGE_STORE"

pnpm stagefabric qualify \
  --bindings examples/runtime-bindings.ollama.yaml \
  --profile examples/runtime-qualification.ollama.yaml \
  > "$EVIDENCE/qualification-report.json"

pnpm stagefabric trust-policy create examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml \
  --profile examples/runtime-qualification.ollama.yaml \
  --certificate-issuer "$SIGSTORE_CERTIFICATE_ISSUER" \
  --identity-email "$SIGSTORE_IDENTITY_EMAIL" \
  --audience "$AUDIENCE" \
  --max-snapshot-age-seconds 300 \
  --max-snapshot-ttl-seconds 300 \
  --clock-skew-seconds 5 \
  > "$TRUST_POLICY"

pnpm stagefabric challenge issue \
  --output "$EVIDENCE/challenge.json" \
  --audience "$AUDIENCE" \
  --ttl-seconds 300

pnpm stagefabric observe examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml \
  > "$EVIDENCE/snapshot.json"

pnpm stagefabric attestation-statement examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml \
  --snapshot "$EVIDENCE/snapshot.json" \
  --qualification-report "$EVIDENCE/qualification-report.json" \
  --profile examples/runtime-qualification.ollama.yaml \
  --trust-policy "$TRUST_POLICY" \
  --challenge "$EVIDENCE/challenge.json" \
  > "$EVIDENCE/statement.json"

pnpm dlx @sigstore/cli@0.10.1 attest "$EVIDENCE/statement.json" \
  --payload-type application/vnd.in-toto+json \
  --tlog-upload \
  --output-file "$EVIDENCE/attestation.sigstore.json"
```

Use `--identity-uri` instead of `--identity-email` when the certificate policy
pins a URI SAN; the command requires exactly one. The external Sigstore command
performs its own OIDC flow. The generated policy is data, not executable config,
and StageFabric never sees or stores the signing key.

Review the authenticated plan without consuming the challenge:

```bash
pnpm stagefabric plan-authenticated examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml \
  --snapshot "$EVIDENCE/snapshot.json" \
  --qualification-report "$EVIDENCE/qualification-report.json" \
  --profile examples/runtime-qualification.ollama.yaml \
  --trust-policy "$TRUST_POLICY" \
  --challenge "$EVIDENCE/challenge.json" \
  --attestation-bundle "$EVIDENCE/attestation.sigstore.json"
```

Execute through the second verification and replay fence:

```bash
pnpm stagefabric run-authenticated examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml \
  --snapshot "$EVIDENCE/snapshot.json" \
  --qualification-report "$EVIDENCE/qualification-report.json" \
  --profile examples/runtime-qualification.ollama.yaml \
  --trust-policy "$TRUST_POLICY" \
  --challenge "$EVIDENCE/challenge.json" \
  --attestation-bundle "$EVIDENCE/attestation.sigstore.json" \
  --challenge-store "$CHALLENGE_STORE"
```

`--challenge-store` must be a stable, private (`0700` on POSIX) directory reused
across runs on that host. The reference adapter can create a missing final
directory with that mode when its parent already exists. It creates one exclusive
marker keyed by challenge digest, so using a fresh temporary directory for every
invocation defeats local replay memory. It is a single-host reference, not a
distributed database; clustered deployments must provide the same consumer port
with a shared atomic store.

The qualification report is an indirect prerequisite of the authenticated
statement: its digest and exact operation coverage must verify. It still grants
no capability, declassification privilege, signer authority, or independent
permission to execute. `plan-authenticated` verifies once and performs no
provider or challenge-store I/O. `run-authenticated` verifies the same copied
bundle twice, compares a stable authorization digest, rechecks the fabric,
binding, and planned snapshot digests, atomically consumes the challenge, and
only then resolves credentials or calls a provider.

## Core contract

The `stagefabric.dev/v1alpha1` planning manifest contains four separately
replaceable inputs:

1. a stage graph with typed inputs and outputs;
2. a policy-defined classification lattice;
3. a fabric of named execution targets;
4. an expiring capability snapshot.

The planner rejects stale snapshots, cycles, missing references, illegal
declassification, and stages with no eligible target. The same canonical inputs
always produce the same plan digest, regardless of object or candidate order.

For live runs, a fifth deployment-owned contract—`RuntimeBindings`—is sealed
separately. Its digest is included in the fresh capability snapshot and execution
plan, then compared with the adapter registry before any stage call. A derived,
namespaced operation observation restricts placement to targets where the exact
bound model was seen. It is structurally separate from public capabilities, and
its reserved namespace can never grant declassification authority.

Authenticated cross-process runs add separate trust policy, qualification,
challenge, and Sigstore-envelope inputs at the application boundary. These do
not change the planner schema or add a trust flag to the plan.

See [Architecture](docs/architecture.md), the [v0.1 delivery contract](docs/delivery-contract.md),
the [v0.2 live-run contract](docs/delivery-contract-v0.2.md),
[runtime-qualification contract](docs/delivery-contract-v0.3-runtime-qualification.md),
[authenticated snapshot contract](docs/delivery-contract-v0.4-authenticated-snapshots.md),
[ADR 0002](docs/adr/0002-live-runtime-bindings.md),
[ADR 0003](docs/adr/0003-runtime-qualification-gate.md),
[ADR 0004](docs/adr/0004-authenticated-capability-snapshots.md), and the
[threat model](docs/threat-model.md).

## Safety model

StageFabric never treats classification as a soft score. An output inherits the
highest input classification unless an explicit rule names an authority
capability present on the selected target. Traces include identifiers, status,
and reason codes only—never payloads, prompts, responses, credentials,
endpoint URLs, or raw upstream errors.

The reference executor retries only a bounded set of failures that occur before
any output is emitted. Ambiguous timeouts and partial streams are never replayed.
The OpenAI-compatible adapter disables SDK retries, performs non-streaming calls,
and normalizes upstream failures to content-free reason codes. Probe and inference
share an exact-origin/path, redirect-free, deadline- and response-size-bounded
fetch boundary.

The package exposes `stagefabric/core` for platform-neutral domain (including
runtime-binding and qualification contracts), planner, executor, and port APIs.
Node YAML/file configuration, HTTP, CLI, demos, and live provider adapters remain
behind the default or `stagefabric/node` entrypoint.

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
and report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Apache-2.0 © Antonio Antenore.

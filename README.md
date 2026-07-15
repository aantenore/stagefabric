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

StageFabric is an experimental `v0.2.0-alpha.1` reference implementation. Its
planner is deliberately deterministic and greedy, not a globally optimal
scheduler. The original in-process demo remains reproducible without credentials
or model downloads. The opt-in Live Fabric Runner now probes and executes real
OpenAI-compatible runtimes while keeping endpoints, models, and credentials out
of the stage graph.

## Quick start

Requires Node.js 24+ and pnpm 11+.

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

See [Architecture](docs/architecture.md), the [v0.1 delivery contract](docs/delivery-contract.md),
the [v0.2 live-run contract](docs/delivery-contract-v0.2.md),
[ADR 0002](docs/adr/0002-live-runtime-bindings.md), and the
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

The package exposes `stagefabric/core` for platform-neutral domain, planner,
executor, and port contracts. Node configuration, HTTP, CLI, demos, and live
provider adapters remain behind the default or `stagefabric/node` entrypoint.

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
and report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Apache-2.0 © Antonio Antenore.

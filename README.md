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

StageFabric is an experimental `v0.1` reference implementation. Its planner is
deliberately deterministic and greedy, not a globally optimal scheduler. The demo
uses in-process targets so its privacy and failover invariants remain reproducible
without credentials or model downloads.

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
pnpm stagefabric serve --host 127.0.0.1 --port 8787
```

The HTTP service exposes `GET /healthz`, `POST /v1/plans`, and
`POST /v1/demo/runs`. It binds to loopback by default.

## Core contract

The `stagefabric.dev/v1alpha1` manifest contains four separately replaceable
inputs:

1. a stage graph with typed inputs and outputs;
2. a policy-defined classification lattice;
3. a fabric of named execution targets;
4. an expiring capability snapshot.

The planner rejects stale snapshots, cycles, missing references, illegal
declassification, and stages with no eligible target. The same canonical inputs
always produce the same plan digest, regardless of object or candidate order.

See [Architecture](docs/architecture.md), [delivery contract](docs/delivery-contract.md),
and [threat model](docs/threat-model.md).

## Safety model

StageFabric never treats classification as a soft score. An output inherits the
highest input classification unless an explicit rule names an authority
capability present on the selected target. Traces include identifiers, timings,
status, and reason codes only—never payloads, prompts, responses, credentials,
endpoint URLs, or raw upstream errors.

The reference executor retries only a bounded set of failures that occur before
any output is emitted. Ambiguous timeouts and partial streams are never replayed.

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
and report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Apache-2.0 © Antonio Antenore.

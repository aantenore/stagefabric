# Delivery contract: StageFabric v0.1

## Outcome

Given a valid stage graph, fabric policy, and fresh capability snapshot,
StageFabric emits a deterministic per-stage execution plan plus an egress proof,
then can execute that plan through explicitly registered adapters.

## Acceptance criteria

- A five-stage demo places work across simulated browser, local, edge, and cloud
  targets.
- Removing a browser capability changes placement without changing application
  code.
- Original email and phone sentinels never reach edge or cloud adapters.
- A simulated pre-output `429` uses the next eligible retrieve target.
- Cycles, missing references, stale capability snapshots, and implicit
  classification downgrades are rejected.
- Reordering semantically unordered config does not change the plan digest.
- Every cross-target or cross-zone transfer has a reason-coded egress record.
- Traces contain no payload, credential, URL, or raw error fields.
- Build, lint, typecheck, tests, CLI, HTTP API, and package contents are verified on
  Node.js 24.
- CI runs on Linux, macOS, and Windows.

## Non-goals

- tensor or model sharding;
- model serving, downloading, or benchmarking;
- a generic agent or workflow framework;
- service discovery, autoscaling, or a distributed control plane;
- production browser transport and real WebGPU models in v0.1;
- globally optimal graph scheduling.

## Release gates

The project is publishable only if `pnpm check`, `pnpm build`, `pnpm pack --dry-run`,
the demo, and HTTP integration tests pass with no secret or author-identity leak.

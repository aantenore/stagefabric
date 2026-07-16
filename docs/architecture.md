# Architecture

StageFabric is a modular monolith with a browser-safe deterministic core and a
thin Node.js composition layer.

```mermaid
flowchart LR
  M["Stage graph + policy"] --> V["Strict schema validation"]
  S["Capability snapshot"] --> V
  V --> P["Pure deterministic planner"]
  P --> X["Execution plan"]
  P --> E["Egress proof"]
  X --> R["Bounded executor"]
  A["Explicit adapter registry"] --> R
  R --> T["Content-free trace"]
```

The opt-in live path extends only the Node composition layer:

```mermaid
flowchart LR
  B["Sealed RuntimeBindings"] --> Q["Bounded /models probe"]
  Q --> S["Fresh snapshot + bindingDigest"]
  S --> P["Deterministic planner"]
  P --> F["Plan/binding fence"]
  B --> F
  F --> O["OpenAI-compatible adapter"]
  O --> V["Ollama / vLLM / serving layer"]
```

Runtime qualification is a separate, opt-in evidence path:

```mermaid
flowchart LR
  B["Sealed RuntimeBindings"] --> S["Strict explicit profile"]
  S --> A["Generation config admission"]
  A --> R["Capped qualifier registry by provider.kind + version"]
  R --> Q["Frozen selected clone + bounded synthetic calls"]
  Q --> E["Sealed configured-wire-shape-v1 report"]
  E -. "release evidence only" .-> C["CI / operator gate"]
```

There is intentionally no edge from a qualification report to the planner,
capability snapshot, executor, or authority model.

The report has no clock field. Its explicit qualification scope, a fixed producer
artifact, and trusted registration-supplied qualifier artifact are included in
its digest instead, preserving deterministic evidence while binding it to named
implementation semantics. Artifact versions do not establish provenance.

Async qualifier code never receives the evidence objects later used to construct
the report. The orchestrator retains a private primitive snapshot and gives the
port a separate recursively frozen target clone containing only admitted selected
operations.

## Modules

- `domain`: core-neutral graph/snapshot/runtime-binding schemas, typed contracts,
  canonical hashing, classifications, and reason codes. Runtime-binding domain
  contracts are available from `stagefabric/core`; Node YAML/file codecs are not.
- `application`: planning and execution use cases. Planning is pure; execution
  depends only on ports. Runtime qualification adds a bounded deterministic
  orchestrator but never feeds planning.
- `ports`: stage-adapter resolution, input-policy guard, and provider-keyed
  runtime-operation qualifier interfaces.
- `adapters`: configuration codecs, bounded network boundary, capability probe,
  in-process targets, OpenAI-compatible provider adapter, and opt-in qualifier.
- `entrypoints`: CLI and Hono HTTP API.
- `composition`: the only place where concrete adapters are registered.

The alpha `RuntimeBindings` provider schema currently admits only the
OpenAI-compatible wire kind. The qualifier port and report are provider-keyed,
but adding a non-OpenAI provider requires an explicit binding-schema and adapter
release; configuration cannot inject a new parser or executable module.

Configuration contains adapter identifiers, never import paths. The composition
root maps those identifiers to code supplied by the host application.

`stagefabric/core` exports only domain, planner, executor, and port contracts.
The default and `stagefabric/node` entrypoints include Node configuration, CLI,
HTTP, demos, and live runtime composition.

## Planning algorithm

The planner validates and stable-topologically sorts the graph, then processes
each stage once. It derives the maximum classification of all incoming values and
selects targets that satisfy health, expiry, capabilities, zone, trust, residency,
and stage-specific constraints.

Candidates are ordered lexicographically by policy zone preference, integer p95
latency, integer cost, then Unicode code-point target identifier. This makes the
result reproducible and avoids unstable floating-point weights. The first target
is primary; the remainder are ordered fallbacks.

This is intentionally a deterministic greedy planner. Cross-stage global
optimization is deferred until it can preserve explainability and reproducibility.

## Data lineage and egress

Every value carries a classification. An output classification is at least the
maximum classification of its inputs. A lower classification requires an explicit
declassification declaration and a target with the named authority capability.

For each dependency whose selected target or zone changes, the plan includes an
egress record with source, destination, classification, and policy reason codes.
The executor consumes a previously validated plan; it does not silently re-plan.

For a binding-bound live snapshot, model discovery records namespaced evidence
for the exact configured operation. The planner checks that evidence as a
separate target-eligibility restriction; it is never inserted into the graph,
fabric, or declassification capability set. Public schemas reserve the namespace.
This prevents both shared-capability confusion and accidental use of availability
evidence as authority.

The generic core can plan explicit declassification for a host that owns a
trusted verifier. The alpha live runner has no output-verification port, so it
rejects every graph containing a declassification before network I/O.

## Extension points

Targets, zones, classifications, capabilities, operations, and adapter kinds are
arbitrary identifiers validated at the boundary. A production host can register
WebLLM, Transformers.js, Ollama, vLLM, Dynamo, or proprietary adapters without a
change to the planner.

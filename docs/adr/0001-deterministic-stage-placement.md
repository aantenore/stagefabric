# ADR 0001: deterministic stage-level placement

- Status: accepted
- Date: 2026-07-15

## Context

Request routers choose a backend for an entire call, while distributed serving
systems place model workers. Neither proves where each application stage may run
or what data crosses between stages.

## Decision

StageFabric plans typed stage DAGs. Privacy and capability constraints are hard
filters; integer latency and cost are deterministic ranking criteria. The core is
provider-neutral and adapters are registered only at the composition root.

## Consequences

Plans are reviewable, reproducible, and portable. The first algorithm is greedy
and may miss a globally cheaper placement; that limitation is explicit rather than
hidden behind an unstable weighted score.

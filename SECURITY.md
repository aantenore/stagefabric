# Security policy

## Supported versions

Until the first stable release, security fixes are applied to the latest commit on
`main`.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for this repository. Do not open
a public issue containing secrets, exploit details, private endpoint addresses, or
user data.

Include the affected revision, impact, a minimal reproduction, and any proposed
mitigation. You should receive an acknowledgement within seven days.

## Scope boundaries

The reference adapters are demonstrators, not a sandbox for untrusted code.
StageFabric configuration cannot load arbitrary modules, but an application that
registers a custom adapter is responsible for isolating it and protecting its
credentials.

The `v0.2` live adapter accepts only sealed, deployment-owned runtime bindings.
The CLI requires them in an operator-selected file separate from the graph. It
requires HTTPS except for loopback HTTP, refuses redirects and destination drift,
bounds deadlines and response bytes, loads optional bearer credentials only
through dedicated `STAGEFABRIC_*` references, and emits content-free trace
failures. A graph cannot provide an endpoint, model, credential reference, or
executable mapping. The live runner rejects declassification declarations until
a trusted output verifier exists; a model's claim or response alone cannot lower
data classification.

This is not a network sandbox. A production host must still protect the binding
registry, constrain process egress/DNS according to its deployment policy, and
treat model outputs as application data. An unkeyed SHA-256 digest detects
mutation; it does not authenticate an externally supplied plan or snapshot.

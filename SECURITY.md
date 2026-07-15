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

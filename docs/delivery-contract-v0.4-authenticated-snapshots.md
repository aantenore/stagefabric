# Delivery contract: authenticated capability snapshots

- Target release: `v0.4.0-alpha.1`
- Status: accepted for implementation
- Scope: cross-process capability evidence for the existing OpenAI-compatible
  live runner

## Problem

StageFabric capability snapshots are canonically hashed and expire, but a hash
only detects mutation. A planner or runner in another process cannot determine
who observed the capabilities, whether the observation belongs to its exact
fabric and runtime bindings, or whether a runtime qualification report was
bound to the same claim.

The current same-process `probe -> plan -> execute` path remains valid. This
slice adds an explicit, fail-closed path for transporting a snapshot between a
trusted probe and a separate planner or runner.

## Outcome

An operator can:

1. observe a sealed capability snapshot from trusted runtime bindings;
2. run the existing bounded operation qualification gate;
3. create a canonical in-toto Statement v1 that binds the snapshot, fabric,
   runtime bindings, qualification report, qualification profile, trust policy,
   audience, and a verifier-supplied challenge;
4. sign that statement with an external DSSE/Sigstore implementation;
5. plan or execute only after StageFabric verifies the Sigstore bundle,
   signer identity, statement scope, evidence digests, challenge, and time
   policy;
6. repeat the evidence fence immediately before execution.

StageFabric does not implement a signing algorithm, issue identities, or store
private keys.

## Trust semantics

The workflow deliberately separates five claims:

| Evidence              | Establishes                                                                                   | Does not establish                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Canonical digest      | Exact bytes were not changed                                                                  | Who produced the bytes                                                     |
| Sigstore verification | A configured identity signed the DSSE payload and the required transparency evidence verifies | That the observed runtime is honest                                        |
| Challenge match       | The statement belongs to the verifier-initiated exchange                                      | Global replay prevention without a caller-owned single-use challenge store |
| Fresh snapshot        | The signed observation is inside the configured age and TTL limits                            | Continuous availability after verification                                 |
| Qualification report  | The exact configured wire shape passed the bounded synthetic checks named by the report       | Model quality, semantic correctness, or production fitness                 |

A signed snapshot grants placement evidence only. It never grants a public
capability, declassification authority, credential access, or permission to
execute a side effect.

## Contracts

### Capability Snapshot Attestation predicate

The DSSE payload is an in-toto Statement v1 with:

- `_type`: `https://in-toto.io/Statement/v1`
- `predicateType`:
  `https://stagefabric.dev/attestations/capability-snapshot/v1`
- three subjects named `stagefabric-capability-snapshot`,
  `stagefabric-runtime-bindings`, and
  `stagefabric-runtime-qualification-report`, each with the existing canonical
  `sha256` digest without the algorithm prefix;
- a strict predicate containing:
  - StageFabric API version and predicate kind;
  - exact audience and the literal authority ceiling
    `placement-evidence-only`;
  - fabric, qualification-profile, trust-policy, and target-scope digests;
  - snapshot `observedAt` and `expiresAt` values;
  - the SHA-256 digest of a 256-bit base64url challenge supplied by the
    verifier. The raw challenge never enters a transparency log.

The statement is canonicalized before output so the same inputs produce the
same unsigned statement bytes.

### Trust policy

The deployment-owned policy contains no executable configuration. It pins:

- the exact certificate issuer;
- one exact URI or email identity (treated as a literal, never a caller
  supplied regular expression);
- one exact audience for the consuming control plane or deployment;
- minimum certificate- and transparency-log thresholds of one;
- one exact fabric digest and qualification-profile digest;
- maximum snapshot age, maximum snapshot TTL, and bounded clock skew.

The Sigstore public-good trust root is the default adapter. Alternative trust
systems must implement the verifier port; they cannot be injected through a
configuration module path.

### Verified evidence

Successful verification returns content-free evidence containing only digests,
the configured signer identity, the challenge digest, verification time, and
snapshot expiry. It never includes endpoints, models, credentials, prompts,
provider output, or raw upstream errors.

## Requirements and acceptance

| ID  | Requirement                                                                                                           | Priority | Acceptance evidence                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| A1  | Statement generation rejects an unsealed or mutated snapshot                                                          | Must     | Unit tests for malformed and digest-mismatched snapshots                   |
| A2  | Statement generation requires a qualified, digest-valid report with the same binding digest                           | Must     | Unit tests for rejected, mutated, and mismatched reports                   |
| A3  | Qualified target/operation coverage exactly matches the snapshot's internal operation observations                    | Must     | Missing and surplus coverage tests                                         |
| A4  | Statement binds the exact fabric, profile, policy, audience, target scope, and 256-bit challenge digest               | Must     | Canonical golden test plus challenge boundary tests                        |
| A5  | Verification uses Sigstore DSSE and an exact configured issuer/identity                                               | Must     | Adapter contract tests proving literal identity escaping and thresholds    |
| A6  | Wrong payload type, predicate type, subject, digest, identity, challenge, or policy fails closed                      | Must     | Table-driven negative tests                                                |
| A7  | Future, expired, over-age, or overlong-TTL snapshots fail closed with bounded clock skew                              | Must     | Boundary-time tests                                                        |
| A8  | Trusted planning returns a plan and separate content-free trust evidence; the core planner never accepts a trust flag | Must     | Application and CLI integration tests                                      |
| A9  | Trusted execution verifies the bundle at planning and again immediately before the existing binding/executor fence    | Must     | Spy-verifier integration test with two calls and mutation/expiry rejection |
| A10 | Existing same-process live runner and deterministic demo remain unchanged                                             | Must     | Existing full suite                                                        |
| A11 | File inputs are size-bounded, strict, and never dynamically import code                                               | Must     | Loader tests and static review                                             |
| A12 | Real Ollama generation and embedding qualification succeeds before release promotion                                  | Should   | Content-free report and documented local evidence                          |

## Explicit non-goals

- custom cryptography, private-key storage, certificate issuance, or a new PKI;
- treating a signature as runtime health, model quality, or semantic truth;
- automatic challenge persistence or a global replay database;
- remote public execution endpoints, service discovery, or workload scheduling;
- SPIFFE/SPIRE, private Sigstore, KMS, and hardware-key adapters in this slice;
- live declassification, streaming, tools, or side-effecting operations;
- replacing the existing same-process probe path.

## Definition of done

- all must requirements pass on Linux, macOS, and Windows;
- package contents include the contracts, verifier port, Sigstore adapter, CLI
  workflow, examples, and documentation;
- public APIs remain provider-neutral outside the Node adapter;
- threat model and architecture distinguish integrity, identity, freshness,
  qualification, and execution evidence;
- no credential, endpoint, prompt, response, or raw error enters an
  attestation statement or verified evidence;
- Git history and package metadata use only the configured personal identity.

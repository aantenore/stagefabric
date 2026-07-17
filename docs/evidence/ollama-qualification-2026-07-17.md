# Ollama qualification evidence — 2026-07-17

## Scope

This record captures the minimum content-free evidence from one local
real-runtime qualification and live execution. It is release evidence for the
`v0.4.0-alpha.1` compatibility slice, not a performance benchmark, model-quality
claim, or proof that every Ollama deployment behaves identically.

The run used:

- [Ollama 0.32.1](https://github.com/ollama/ollama/releases/tag/v0.32.1);
- [Node.js 24.15.0](https://nodejs.org/en/blog/release/v24.15.0);
- `nomic-embed-text:latest` for `embed`;
- `qwen3:4b` for `generate`;
- the checked-in `examples/runtime-bindings.ollama.yaml` and
  `examples/runtime-qualification.ollama.yaml` fixtures.

The consolidated binding uses a 300-second snapshot TTL, a 512-token maximum
generation output, and the exact 768-dimensional embedding contract. The profile
uses a 60,000 ms total deadline, one target worker, two selected operations, and
a 512-token generation ceiling.

## Reproduction boundary

With Ollama listening on loopback and both models already pulled, the evidence
was produced with:

```bash
pnpm stagefabric qualify \
  --bindings examples/runtime-bindings.ollama.yaml \
  --profile examples/runtime-qualification.ollama.yaml \
  > /tmp/stagefabric-ollama-qualification.json

pnpm stagefabric run examples/live-stagefabric.yaml \
  --bindings examples/runtime-bindings.ollama.yaml \
  > /tmp/stagefabric-ollama-live-run.json
```

The temporary outputs were inspected to derive the allowlisted observations
below and were not copied into the repository.

## Content-free evidence

| Artifact or observation         | Verified value                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| Runtime binding digest          | `sha256:87d303ca7571c2e02a6a2f8c4d23dfed66a8d0bb8308b64535f07770c1277284` |
| Qualification profile digest    | `sha256:cd5bb08777c1290b069a6b94b16d8fad5e03d0c516747d71bd9030e85648e98f` |
| Qualification report digest     | `sha256:31fab331a766073931d497a2f6516c7b434e06dc4d5c20121686ae72a9ff01b0` |
| Qualification result            | `qualified: true`; `embed` and `generate` both qualified                  |
| Live capability snapshot digest | `sha256:35f0da61de575eea2b3c8396ae052f986b1fd6f0c1935ab391a1a6c0a013ee12` |
| Live execution plan digest      | `sha256:6157243b0fc9509f134aa4dfaecc1d243493e9d41b2e0c449c8ac3e01cf31911` |
| Embedding output shape          | 768 finite dimensions                                                     |
| Generation output shape         | 123 visible answer characters                                             |
| Execution outcome               | Both graph stages succeeded                                               |

No prompt, system instruction, generated text, embedding value, credential,
endpoint response, model payload, or raw error is retained here.

## Calibration found by the first run

The first real attempt exposed two useful fixture assumptions rather than being
discarded as noise:

1. Ollama advertised the embedding model under the normalized
   `nomic-embed-text:latest` alias. StageFabric intentionally requires exact
   operation/model observation, so the binding was changed from the unqualified
   alias to that exact advertised identifier.
2. Qwen's reasoning behavior had to fit inside the configured generation output
   budget. The binding and profile ceiling were raised together to 512 tokens so
   the qualifier tested the same admitted knob used by the live adapter.

After those explicit configuration corrections, qualification and the live
two-stage rerun passed. This demonstrates why the real-runtime gate is useful:
advertised model presence alone would not have exposed either mismatch.

## Interpretation

The qualification report proves only the named
`configured-wire-shape-v1` contract for this runtime/version/fixture combination.
In the authenticated snapshot workflow its digest becomes an indirect,
scope-checked prerequisite of the signed statement. It remains non-authoritative:
it cannot grant placement capabilities, declassification, credentials, side
effects, model honesty, or semantic quality.

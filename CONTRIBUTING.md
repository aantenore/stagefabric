# Contributing

StageFabric favors small, composable changes that preserve deterministic planning
and provider neutrality.

1. Open an issue for changes to the public manifest or security model.
2. Add tests for every new invariant or reason code.
3. Run `pnpm check` and `pnpm build` before opening a pull request.
4. Keep adapters behind ports; do not add provider names or credentials to the
   domain or planner.
5. Never log stage payloads, prompts, responses, tokens, endpoint URLs, or raw
   errors.

Use Conventional Commit-style subjects where practical. All contributions are
accepted under Apache-2.0.

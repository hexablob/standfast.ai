## What and why

<!-- What changed, and why. The diff already says what; spend the words on why. -->

## Guardrails

Tick what applies. A ticked box is not a rejection — it is a flag that the
description has to address.

- [ ] Adds a dependency (justify it; `packages/core` is meant to have none)
- [ ] Adds an MCP tool (the budget is ten — what does this cost per session?)
- [ ] Puts a model call on the read path (there are none, by design)
- [ ] Adds a hosted memory or retrieval SDK to a workspace package
- [ ] Breaks a principle in `docs/02-principles.md` (say which, and why)
- [ ] Changes `infra/openapi/openapi.json` (breaking for clients?)
- [ ] Touches row-level security or a privacy boundary

## Checks

- [ ] First contribution: I have signed the [CLA](../CLA.md) in a comment below

- [ ] `pnpm lint && pnpm exec tsc -b && pnpm test` pass locally
- [ ] New migration has a hand-written `*.down.sql` and survives up → down → up
- [ ] Privacy or tenancy change comes with a test that *attempts* the violation
      and asserts it fails
- [ ] `infra/openapi/openapi.json` regenerated and committed if the API moved

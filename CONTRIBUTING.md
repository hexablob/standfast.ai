# Contributing

## Setup

Node 26 (`nvm use`) and pnpm 10. `pnpm install` also points `core.hooksPath` at
`.githooks`, which is what installs the guards — if you skip the install you
also skip them.

```bash
nvm use && pnpm install
pnpm test && pnpm lint && pnpm exec tsc -b
```

`pre-commit` refuses three things: a staged file under `notes/`, a named third
party in the diff, and a staged source file that Biome rejects. The denylist
lives in `.githooks/blocked-terms`, which is gitignored — copy
`.githooks/blocked-terms.example` if you need one. Writing those names into the
hook itself would publish exactly what the hook exists to keep out of a public
repository.

`commit-msg` refuses a message that is not a Conventional Commit. Both hooks
skip themselves when `node_modules` is absent: a hook that fails on a fresh
clone only teaches people to pass `--no-verify`.

## The design documents outrank your pull request

`docs/02-principles.md` takes precedence over implementation preference. A pull
request that breaks one of the thirteen principles is not automatically
rejected, but it must say which one and justify it in the description. Silently
breaking one is the only version that gets turned down on sight.

`docs/03` through `docs/15` each open with a status banner — `settled`,
`designed, not implemented`, or `planned`. It is load-bearing, and it is not a
prohibition: these are designs meant to be implemented as their phase lands.
What it tells you is how much of the document is already true of the code, and
each one names the files that hold whatever part is. Do not read a settled
design as a description of a running system.

## What to work on

`docs/14-roadmap.md` is the phase contract. It says which phase owns which
work, which design document owns each phase, and what the exit criteria are —
and the exit criteria are the definition of done, not a summary of it. Phase 0
is complete and every one of its criteria is checked in CI; phase 1 is
extraction.

`docs/00-handoff.md` is the shorter read: every settled decision, every open
question, and what to pick up next.

## Things that need a conversation before the code

- **A new dependency.** Justify it in the pull request. `packages/core` has
  none and is meant to keep it that way.
- **An eleventh MCP tool.** The budget is ten. Every tool description costs
  tokens in every session and degrades the agent's selection accuracy, so a new
  one is a design decision, not an addition.
- **A model call on the read path.** There are none, by design. Token budget
  and p95 latency are contracts.
- **A hosted memory or retrieval SDK in any workspace package.** Routing part of
  the knowledge layer through a third-party service breaks the third founding
  invariant.

## Migrations

Every migration is reversible and proven so. `drizzle-kit generate` writes the
forward half; you write `NNNN_*.down.sql` yourself. CI applies up, then down,
then up again against a throwaway database, and a migration that cannot survive
that round trip does not merge. See `packages/db/README.md`.

## Tests

Unit tests run with no database. Anything needing Postgres is named
`*.integration.test.ts` and is skipped unless `DATABASE_URL` is set, so a fresh
clone runs `pnpm test` green offline.

Row-level security gets regression tests that *attempt* to cross a tenant
boundary and assert the failure. A guarantee nobody tries to break is a policy
statement, and policy statements are not what we are selling.

## Commits and pull requests

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`,
`test:`). The subject says what changed; the body says why, when why is not
obvious from the diff.

Those seven types are the whole list, and commitlint enforces it — locally in
the `commit-msg` hook, and in CI over every commit in the pull request plus the
title, since the merge button squashes the range into one commit that takes the
title as its subject. Adding an eighth type means editing this paragraph and
`commitlint.config.js` in the same commit; the rules that were relaxed, and why,
are written in that file.

Keep the pull request narrow enough to review in one sitting. CI must be green:
Biome, `tsc -b`, Vitest, the migration round trip, and the OpenAPI drift check.
If `infra/openapi/openapi.json` is stale, run `pnpm openapi:generate` and commit
the result — that artifact is the guard against an accidental breaking change,
so it is never regenerated silently by CI on your behalf.

## Licensing and the CLA

Contributions to `api`, `core`, `db` and `worker` are AGPL-3.0-only.
Contributions to `cli`, `mcp` and `sdk` are Apache-2.0.

First-time contributors are asked to sign the [Contributor License
Agreement](./CLA.md) by commenting on their pull request. It is short, it does
not take your copyright, and [`CLA.md`](./CLA.md) explains plainly why it is
asked for: it keeps open the option of selling a commercial licence to
organisations whose legal policy forbids the AGPL, and it carries an explicit
patent grant.

Code already published under the open source licences stays published. Nothing
in the CLA can retract it.

If you would rather not sign, open an issue describing the change. That is a
real contribution and is credited as one.

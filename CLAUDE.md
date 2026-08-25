# Standfast — project instructions

## What we are building

A shared knowledge layer for coding agents. Standfast holds a project's decisions,
conventions and constraints, serves each agent only what governs the file in
front of it over MCP, then records whether the code still honors them. Source
code never leaves the customer's machine.

Read `docs/01-thesis.md` and `docs/02-principles.md` before proposing any
implementation. The three founding invariants live in the thesis; the design
principles take precedence over implementation preference. Do not restate either
list here — one fact, one home.

## Stack (settled)

TypeScript, Node 26, pnpm + Turborepo monorepo. Hono with `@hono/zod-openapi`
for the API: Zod schemas are the single source, and they generate the OpenAPI
spec, the typed client and the CLI. Postgres 16 with pgvector (HNSW, 1024
dimensions), tsvector and pg_trgm. pg-boss for the job queue — transactional
enqueue is mandatory. Row-level security written in the first migration.

## Code conventions

`packages/core` is pure domain: no I/O, testable without a database. Every
migration is reversible and tested against an ephemeral database. No new
dependency without justification in the pull request. The generated OpenAPI
artifact is committed — its diff is the guard against accidental breaking
changes. All repository content is written in English.

## Local agent tooling

Supermemory runs as a Claude Code plugin for sessions on this repository. It is
developer tooling only: session recall for whoever is working on Standfast, scoped to
its own container. It is not a dependency of Standfast, is never imported by product
code, and never receives customer source, documents or atoms. Routing any part of
the knowledge layer through a hosted memory service would break the third
founding invariant.

Its credential is `SUPERMEMORY_CC_API_KEY`, read from the developer's shell
environment. It does not belong in a project `.env` file — a key in the project
tree implies a runtime dependency that does not exist.

## Current phase

Phases 0, 1 and 2 are built. Phase 0 shipped the monorepo, the core schema with
RLS, CRUD for projects, documents and atoms, auth, the CLI, and the first three
MCP tools. Phase 1 shipped extraction end to end — the schema invariants, the
evaluation harness, the queue, worker and pipeline, and in 1d the real providers
behind the three ports. Phase 2 shipped retrieval: the indexes, four candidate
generators of which three run, RRF, MMR and budgeted assembly in
`packages/core`, the `context` and `search` tools, and the `SessionStart` and
`UserPromptSubmit` hooks.

**Providers are bound, and the egress allowlist governs them.**
`packages/worker/src/adapters/` holds `AnthropicExtractor` and `AnthropicJudge`,
`VoyageEmbedder`, and `BgeEmbedder` for a deployment that runs its own model.
`packages/worker/src/main.ts` `resolvePorts` parses
`STANDFAST_EGRESS_ALLOWLIST` before it constructs anything and refuses at
start-up: an allowlist with only fakes behind it, a mixed real-and-fake
configuration, a prompt-version mismatch, and any purpose without an entry. The
read path has its own resolution in `packages/api/src/ports.ts`. The
deterministic fakes remain, and they are what still lets the whole thing run in
CI with no network and no secrets.

What phases 1 and 2 have *not* done is claim their exit criteria. Extraction
precision, retrieval precision under budget and the declared p95 are all
unmeasured, because the corpus and its human labels do not exist. That is the
binding constraint on this project, not more code.

Phase 3 shipped reconciliation — the moat, and the sixth and last MCP tool the
specification names. `docs/07-reconciliation.md` owns it. The rules that hold it
together: no field of `reconcile` accepts source code; the findings tables are in
`packages/db/src/schema/wire-allowlist.ts`; the rationale is the only free-text
field anywhere on the path and `docs/13-threat-model.md` still has "is a length
cap sufficient, or does free text have no place here at all" open against it;
prompts are written to falsify, never to confirm; findings are recorded and never
acted on; and only a human resolves one. **Its exit criterion is not met.** The
false-positive rate is unmeasured, `eval/baselines.json` keeps `baseline: null`,
and `pnpm eval reconciliation` reports SKIPPED. Built is not measured.

Phase 4 is in progress — distribution and the ratification loop, which exists
because the bottleneck is a human reading provisional atoms
(`docs/02-principles.md`, 5). `docs/15-ratification.md` owns the behaviour and
`docs/14-roadmap.md` the boundaries. Two questions are now settled: retiring a
canonical atom with no successor uses a **fifth status, `retired`**, rather than
a `canonical → rejected` transition, because `rejected` must keep meaning "a
human said no to a proposal" — the signal extraction precision is measured with;
and the **ratification venue is the CLI**.

Below the surface: migrations 0011 (the closed rejection vocabulary, and the
labelled corpus that falls out of ordinary use), 0012 (`retired`), and 0013,
which makes "only a human decides" a constraint on `atom_events` rather than a
predicate in a repository — an agent could write a `rejected` event until it
landed. `packages/db` has `rejectAtom`, `retireAtom`, ratify-with-`supersedes`,
and the queue and throughput queries.

**Registry publication does not happen in phase 4.** A server that serves almost
nothing spends a first impression that cannot be spent twice, and the kill metric
above is unmeasured. The plugin manifest, the packaging and the release job are
in scope; publishing is not.

Do not flip `extractorAvailable()` in `eval/src/preconditions.ts`. A fake
extractor is not an extractor, and a bar set against a bullet-splitter could
never be defended.

`eval/` holds the harness. It has the corpus, the label format, the scoring
functions and `pnpm eval check`, and it has no labels — a human writes those
blind, before the first prompt, and no model may do it for them. Three of the
four bars are `null` in `eval/baselines.json` on purpose; do not fill one in
without a corpus to set it against.

`docs/14-roadmap.md` owns the phase boundaries and the exit criteria; read it
before starting phase-3 work, `docs/07-reconciliation.md` for the
reconciliation loop, `docs/05-extraction.md` for the extraction
pipeline, and `docs/12-evaluation.md` before touching anything under `eval/`.

## Do not

Start extraction or embeddings before phase 0 is complete. Build team features
before phase 5. Add an MCP tool beyond the six specified in
`docs/08-mcp-server.md` — the cap of ten is a budget with four slots
deliberately unspent, not four tools already sanctioned — without discussing
the per-session token cost. Put a **generative** model call on the read path —
`docs/02-principles.md` (4) admits only pinned, bounded embedding and
reranking, and `docs/06-retrieval.md` names the two calls and the five
conditions on each; anything beyond those, and anything that generates text,
is out. Let an agent promote its own knowledge. Add a hosted memory or
retrieval SDK to any workspace package.

<!-- The Standfast managed block goes here once the product self-hosts. -->

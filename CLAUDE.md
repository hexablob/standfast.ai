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

Phase 0 is complete — monorepo, core schema with RLS, CRUD for projects,
documents and atoms, auth, the CLI, and the MCP server with three tools.

Phase 1 is extraction. `docs/14-roadmap.md` splits it into 1a to 1d, and 1a, 1b
and 1c have shipped: the schema invariants, the evaluation harness, and the
queue, worker and pipeline. **There is still no intelligence in the system.**
The three ports the pipeline runs on — extractor, embedder, dedup judge — are
satisfied by deterministic fakes, which is what lets the whole thing run in CI
with no network and no secrets. Nothing in this repository calls a model.

Phase 1d is what remains: binding real providers behind those three ports, and
the outbound allowlist that governs them. 1d opens the first outbound socket
here, so the allowlist and its start-up refusal land with it, not in phase 2.
`packages/worker/src/main.ts` `resolvePorts` is where both go.

Do not flip `extractorAvailable()` in `eval/src/preconditions.ts`. A fake
extractor is not an extractor, and a bar set against a bullet-splitter could
never be defended.

`eval/` holds the harness. It has the corpus, the label format, the scoring
functions and `pnpm eval check`, and it has no labels — a human writes those
blind, before the first prompt, and no model may do it for them. Three of the
four bars are `null` in `eval/baselines.json` on purpose; do not fill one in
without a corpus to set it against.

`docs/14-roadmap.md` owns the phase boundaries and the exit criteria; read it
before starting phase-1 work, `docs/05-extraction.md` for the extraction
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

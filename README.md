# Standfast

A shared knowledge layer for coding agents.

Every session your agent starts, it starts from nothing. It rediscovers the
project's conventions — usually by violating one and being corrected — and the
correction is thrown away when the session ends. The next agent, on a different
tool, repeats it.

Standfast holds a project's decisions, conventions and constraints, serves each agent
only what governs the file in front of it over MCP, and records whether the code
still honors them.

**Agents read the code. Standfast keeps the verdict. It never sees the source.**

## The three invariants

Everything here follows from these. They are not preferences.

1. **Atoms are a projection of documents.** Knowledge is extracted from
   versioned prose, never hand-minted, so it can be re-derived when models
   improve and always carries a citable source.
2. **Everything an agent writes is born provisional.** Human ratification is
   what makes the knowledge base worth querying — it is the mechanism that
   produces trust, not friction to be optimized away.
3. **Source code never leaves the machine.** Reconciliation runs inside the
   customer's own agent session. What comes back is a verdict and a
   `path:line`.

Read `docs/01-thesis.md` for the argument and `docs/02-principles.md` for the
design rules that follow from it.

## How this differs from the alternatives

Sharing context between coding agents is a crowded space. Most of it solves a
different half of the problem:

| Approach | What it does | What it does not do |
| --- | --- | --- |
| `AGENTS.md` + a sync script | one canonical file, generated into each tool's format | tell you when the code stopped matching the file |
| Rule generators (RuleSync and similar) | keep `CLAUDE.md`, `.cursor/rules` and friends in step | scope per file, or verify anything |
| Agent memory services | remember across sessions, served over MCP | separate a decision from a passing remark, or require a human to ratify either |
| Injection proxies | put context into the model request | leave an auditable record of what governs what |

Those all answer **storage and distribution**. Standfast is built for the part
none of them touch: *does the code still honor the decisions?* Keeping a record
of a decision is easy. Knowing whether it is still true is the hard part, and
it is the only part worth building a company around.

Two consequences fall out of that:

- **Nothing an agent writes becomes canonical on its own.** Knowledge is
  extracted from versioned prose, cited back to the sentence it came from, and
  stays provisional until a human ratifies it. The database refuses otherwise —
  it is a foreign key, not a policy.
- **We never receive your source.** Reconciliation runs inside your own agent
  session; what comes back is a verdict and a `path:line`.

**Being straight about maturity:** reconciliation is the point of Standfast and it
is not built yet — it is phase 3. Today the repository has the schema, the
tenancy boundary, the API and the CLI. If you need something that works this
afternoon, one of the tools above will serve you better, and we would rather
say so than waste your evening.

## Status

**Phase 0 is complete** — monorepo, core schema with row-level security, CRUD,
auth, the generated SDK, the CLI, and an MCP server with three tools. **Phase 1
is under way**: the extraction schema and the evaluation harness have shipped,
the queue and the pipeline have not. There is still no intelligence in the
system — nothing in this repository calls a model.

The design set under `docs/` is written in full: `docs/03` through `docs/15`
are settled designs, not stubs. Almost none of it is built. Every one carries a
status banner — `settled`, `designed, not implemented`, or `planned` — and
names the files that hold whatever part exists today. Read the banner before
inferring anything from the prose.

## Stack

TypeScript on Node 26, pnpm and Turborepo. Hono with `@hono/zod-openapi`, where
Zod schemas are the single source that generates the OpenAPI spec, the typed
client and the CLI. Postgres 16. Row-level security lands in the first
migration, not later.

The rest of the stack is settled and not yet running: pgvector's HNSW index,
`tsvector` and `pg_trgm` for retrieval, and pg-boss for the queue with
transactional enqueue. Phase 0 installed the `vector` and `pg_trgm` extensions
and created no index that uses either — they ship early because adding one
later needs a superuser on a live database. Phase 1a added
`atoms.embedding vector(1024)`, deliberately without an index: HNSW parameters
are chosen against a real vector distribution, and phase 1 only writes vectors.
There is still no `tsvector` anywhere, and `packages/worker` is one line of
`export {}`.

## Getting started

```bash
nvm use              # Node 26, per .nvmrc
pnpm install         # also installs the git hooks
pnpm test            # green with no database — integration tests self-skip
pnpm lint
pnpm exec tsc -b
```

For anything touching the database:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=standfast \
  --name standfast-db pgvector/pgvector:pg16
cp .env.example .env
pnpm db:migrate

# Two steps, not one. `db:migrate` creates the `pgboss` schema and the grants
# on it; pg-boss installs its own tables inside it. Vendoring its generated
# DDL into a migration would give this repository a second version ledger that
# can disagree with the one pg-boss already keeps.
pnpm db:queue:install

# The API refuses to start on a superuser or BYPASSRLS connection: such a role
# makes every tenant policy silently inactive while the application looks
# perfectly healthy. Create a restricted role once.
psql "$DIRECT_URL" -c "CREATE ROLE standfast_api LOGIN PASSWORD 'standfast_api' NOBYPASSRLS" \
                   -c "GRANT standfast_app TO standfast_api"

pnpm --filter @standfast/db run bootstrap "My org" "My name"
pnpm start                      # DATABASE_URL must be the standfast_api role
```

Migrations, `db:queue:install` and `bootstrap` run as the owner
(`DIRECT_URL`); only the API uses the restricted role.

The last command creates an org, a human actor and an API key, printing the
key once — only its SHA-256 is stored. It is ops tooling rather than an
endpoint on purpose: an unauthenticated route that mints the first credential
is an unauthenticated route that mints credentials.

```bash
standfast login --key sf_sk_… --url http://localhost:8080
standfast project create "My project"
standfast doc push docs/*.md --project <id>
standfast export ./my-knowledge     # full Markdown, yours to keep
```

## Connecting a coding agent

The MCP server exposes the three tools that exist in phase 0 — `read`,
`propose` and `status`. `context`, `search` and `reconcile` are specified in
`docs/08-mcp-server.md` and are not stubbed out: a tool that returns nothing
teaches an agent not to call it again.

```jsonc
{
  "mcpServers": {
    "standfast": {
      "command": "standfast-mcp",
      "env": {
        "STANDFAST_API_KEY": "sf_sk_…",
        "STANDFAST_BASE_URL": "http://localhost:8080"
      }
    }
  }
}
```

An agent can propose knowledge; it cannot ratify it. There is no ratify tool,
and the composite foreign key behind it means the database would refuse even if
there were.

## Layout

| Package | Contents |
| --- | --- |
| `packages/core` | pure domain logic, no I/O, no runtime dependencies |
| `packages/db` | schema, reversible migrations, row-level security |
| `packages/api` | HTTP API; Zod schemas generate everything downstream |
| `packages/worker` | pg-boss consumers — phase 1; empty today |
| `packages/sdk` | typed client generated from the committed OpenAPI artifact |
| `packages/cli` | the `standfast` binary |
| `packages/mcp` | MCP server — three tools today, six specified; ten is a budget, not a start |

`infra/openapi/openapi.json` is committed on purpose. CI regenerates it and
fails on a diff, so a breaking API change shows up in review rather than at
someone's integration.

## License

Deliberately split, one repository, two halves:

- **AGPL-3.0-only** — `api`, `core`, `db`, `worker`. Running a modified Standfast as
  a network service obliges you to publish the modifications.
- **Apache-2.0** — `cli`, `mcp`, `sdk`. These run on your own machine and are
  integration surface; integration surface with a copyleft obligation attached
  does not get integrated.

See [`NOTICE`](./NOTICE).

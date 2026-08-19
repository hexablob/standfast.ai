<!-- docs/03-architecture.md -->
# Architecture

> **Status: settled.** The package boundary, the licence split, the dependency
> direction, the trust boundary and the request lifecycle below are implemented
> in phase 0 and in force today. Two things are named but not built:
> `packages/worker` is an entrypoint with nothing behind it, and pg-boss is a
> declared dependency with no import. Every such statement is marked where it
> appears.

## What this document fixes

Three decisions here are expensive to reverse once code exists, and cheap now:

1. **Which package may import which.** A cycle discovered in month six is a
   refactor of everything on the cycle.
2. **Where the licence line runs.** You cannot licence half a package, so the
   licence boundary has to be a directory boundary, decided before the
   directories fill up.
3. **What is allowed to cross the wire.** Invariant 3 in `docs/01-thesis.md` —
   source code never leaves the machine — is not a runtime check bolted on
   later. It is the shape of the component graph.

Everything else in this document follows from those three.

## The seven packages

| Package | Licence | Responsibility | State |
| --- | --- | --- | --- |
| `core` | AGPL-3.0-only | Pure domain. Markdown sectioning, content and section hashing. No I/O. | Implemented |
| `db` | AGPL-3.0-only | Schema, reversible migrations, row-level security, `withActor`, key resolution, repositories. | Implemented |
| `api` | AGPL-3.0-only | HTTP surface. Zod schemas generate the OpenAPI artifact, which generates the client. | Implemented (phase-0 CRUD) |
| `worker` | AGPL-3.0-only | pg-boss consumers. | **Entrypoint only** |
| `sdk` | Apache-2.0 | Typed client, generated from the committed OpenAPI artifact. | Implemented |
| `cli` | Apache-2.0 | The `standfast` binary. | Implemented (phase-0 commands) |
| `mcp` | Apache-2.0 | The `standfast-mcp` stdio server. | Implemented (`read`, `propose`, `status`) |

`core` has no runtime dependencies at all, which is what makes
`CLAUDE.md`'s "testable without a database" a property rather than an
aspiration: there is nothing in it to stub. `sectionMarkdown`, `contentHash`
and `sectionHash` are functions of their arguments. When phase 1 adds
extraction, the parts of it that are decisions rather than calls belong here
for the same reason.

`sdk` has exactly one runtime dependency (`openapi-fetch`) and `cli` has
exactly one (`sdk`). The CLI parses arguments with `node:util`'s `parseArgs`
rather than a framework, because every dependency in a client package is a
dependency the customer installs.

## The licence boundary, and why it sits there

AGPL on the server half, Apache-2.0 on everything that runs on a user's
machine. The rule that produces the split is one sentence: **anything that
ships to a user's machine must not carry copyleft.**

The two halves are protecting different things.

- The server exists to be self-hosted and must not be quietly closed over. If
  someone modifies Standfast and runs it as a network service, the AGPL obliges
  them to publish the modification. That obligation is the point, and it binds
  our own hosted version too — so hosted differentiates on operations and
  bundled model spend, not on secret code (`docs/00-handoff.md`).
- The client half is integration surface. A CLI, an SDK and an MCP server are
  things people embed in build scripts, editor configs and other companies'
  tooling. An integration surface with a copyleft obligation attached does not
  get integrated — legal review kills it before an engineer ever tries it.

This is why the boundary must be a directory boundary. A single package with
mixed licensing is unreviewable: nobody can tell from a diff whether a new
import crossed the line. Split into packages, the violation is a line in a
`package.json` that a reviewer sees.

The mechanical rule that falls out:

> **No Apache package may import an AGPL package.** `cli`, `mcp` and `sdk`
> reach the server over HTTP and nothing else.

`packages/sdk/src/index.ts` says this in a comment at the top of the file,
where someone about to add an import will read it.

The reverse direction is fine and is used: `packages/api` declares `sdk`, `cli`
and `mcp` as **devDependencies**, and its integration tests drive the real
client packages against the app in-process. AGPL code consuming Apache code
creates no obligation, a devDependency does not ship, and `files: ["dist"]`
means the published client packages carry nothing of the server.

## Dependency direction

The runtime graph, exactly as `package.json` and the `tsconfig.json`
`references` arrays declare it:

| Package | Depends on |
| --- | --- |
| `core` | — |
| `db` | `core` |
| `api` | `core`, `db` |
| `worker` | `core`, `db` |
| `sdk` | — |
| `cli` | `sdk` |
| `mcp` | `sdk` |

It is a forest, not a graph: two trees rooted at `core` and `sdk`, with no edge
between them. That absence is the design. The only thing joining the halves is
`infra/openapi/openapi.json` — a committed file.

```
  AGPL half                          Apache half

  core ──► db ──┬──► api             sdk ──┬──► cli
                └──► worker                └──► mcp
                       │                       ▲
                       ▼                       │
              infra/openapi/openapi.json ──────┘
                   (committed artifact)
```

Direction is one-way because the alternative is a shared package, and a shared
package is where the licence argument would live forever. Every type either
half needs from the other is either derived from the OpenAPI document or does
not cross. `api` generates `openapi.json` from the same Zod schemas that
validate its requests (`openapi:generate`); `sdk` generates `src/schema.d.ts`
from that committed file, not from a running server (`sdk:generate`). CI
regenerates both and fails on a diff, so the artifact drifting is a red build
rather than a client that compiles and 400s.

Considered and declined: a `@standfast/types` package imported by both halves. It
would be a single module under two conflicting licence regimes, and every
addition to it would reopen the question. Sharing a *data file* has none of
that problem, because data is not linked.

Also declined: a hand-written SDK. Two independent descriptions of one contract
drift silently; a generated one drifts loudly, in CI, in the same commit.

## The trust boundary

This is the diagram to hold in your head before touching anything else.

```
      CUSTOMER'S MACHINE                     │        STANDFAST SERVER
   ──────────────────────────────────────────╂───────────────────────────────
                                             │
   repository ─┐                             │
               │                             │
   coding      │  source, file trees,        │
   agent ──────┤  ASTs, call graphs,         │      ✗ no representation
       │       │  diffs, snippets            │        of source exists
       │       └────────╳────────────────────│        anywhere here
       │                 never cross         │
       │                                     │
   standfast-mcp ──┐                         │
   (stdio)         │                         │
                   ├─► @standfast/sdk ─ HTTPS┼─► @standfast/api
   standfast CLI ──┘   Bearer sf_sk_…        │        │  requireApiKey
       ▲                                     │        │  asTenant → withActor
       │                                     │        ▼
   developer      crossing, both ways:       │   Postgres  (RLS forced,
                  statements, verbatim       │   standfast_app, no BYPASSRLS)
                  quotes, section ids,       │        │
                  verdicts, path:line        │        ▼
                  pointers, token            │   @standfast/worker  (pg-boss)
                  budgets                    │   ── not implemented ──
```

Reconciliation is the case that makes the boundary real rather than
decorative. The agent reads the code — locally, in its own session, on the
left-hand side of the line — and what it sends back is a verdict and a
`file_path` / `line_start` / `line_end` triple. `docs/08-mcp-server.md` states
that no field of `reconcile` accepts code: *not truncated, not hashed, not
"just a snippet"*. Phase 3 owns the tool; the boundary it has to respect is
settled now.

The enforcement is not in this document, and deliberately not in a policy
statement. `packages/db/src/schema/wire-allowlist.ts` names the exact column
set of every table whose rows cross the wire, and a test compares it against
`information_schema.columns`. Adding a column fails the build until someone
adds it to the allowlist in a diff a reviewer will see. Allowlist, never
denylist (`docs/02-principles.md`, 9): a denylist would have to anticipate the
name of the column nobody thought to forbid.

Two consequences worth stating plainly, because both are easy to violate by
accident:

- **The MCP server does not talk to Postgres.** It talks to the API, like any
  other client. Doing otherwise would require shipping the AGPL `db` package to
  the customer's machine *and* would move the tenancy boundary into a process
  the customer controls. Policy enforcement stays on the server side of the
  wire.
- **`packages/db` exposes no raw pool.** `getPool` is absent from `index.ts`,
  and the package `exports` map publishes only `.`, so Node refuses a deep
  import. A boundary you can cross by forgetting a wrapper is not a boundary.

## Request lifecycle

One `read` call, end to end, naming the functions that actually run. The CLI
path is identical from step 3 onward.

1. **`packages/mcp/src/bin.ts`** reads `STANDFAST_API_KEY` and `STANDFAST_BASE_URL`,
   then `createServer().connect(new StdioServerTransport())`. Diagnostics go to
   stderr; stdout carries the protocol.
2. **`createServer`** (`packages/mcp/src/server.ts`) registers the phase-0
   tools. The `read` handler dispatches on `kind` to one of three API paths.
3. **`createClient`** (`packages/sdk/src/index.ts`) wraps `openapi-fetch`,
   typed by `paths` from the generated `schema.d.ts`, and attaches
   `Authorization: Bearer sf_sk_…`.
4. **`createApp`** (`packages/api/src/app.ts`) routes the request.
   `/health` is unauthenticated on purpose — a health check that requires a
   credential is a health check nothing can call. Everything under `/v1/*`
   passes through `requireApiKey`.
5. **`requireApiKey`** (`packages/api/src/middleware/auth.ts`) calls
   `resolveApiKey` (`packages/db/src/auth.ts`), which runs
   `select … from auth.resolve_api_key($1)`. This is the **only** query in the
   request path outside `withActor`, because the tenant is precisely what it is
   computing. It sets `orgId`, `actorId` and `scopes` on the Hono context.
6. **The route handler** (`packages/api/src/routes.ts`) calls `asTenant(c, fn)`,
   which is `withActor(orgId, actorId, fn)`.
7. **`withActor`** (`packages/db/src/client.ts`) opens a transaction and issues
   `set_config('standfast.org_id', …, true)` and `set_config('standfast.actor_id', …,
   true)`. The `true` is transaction-scope, and it is load-bearing under a
   connection pool: a session-scoped setting would leak one request's tenant
   into the next request served by the same connection.
8. **The repository function** runs inside that transaction. Policies from
   `0000_foundation.sql` compare `org_id` against
   `nullif(current_setting('standfast.org_id', true), '')::uuid`. An unset GUC
   yields `NULL`, `org_id = NULL` is never true, and the query returns zero
   rows. Failing closed is the entire point; see `docs/04-data-model.md` for
   why the `nullif` is not decoration.
9. **The response** is validated by the same Zod schema that produced the
   OpenAPI artifact in step 3's type. `serialize` converts `Date` to ISO
   strings; `handleErrors` maps constraint violations to status codes.

`propose` follows the same path and ends at `createAtom`, which cannot write
`status`. `ratify` exists only over HTTP and only for a human actor: the route
checks `getActorKind` to produce a readable 403, and the composite foreign key
`(ratified_by, ratified_by_kind) → actors (id, kind)` plus
`check (ratified_by_kind = 'human')` is what actually refuses. The check in the
route is the error message. The database is the enforcement.

## The two roles

Three roles exist in the database. Two of them are in the request path, and the
third owns exactly one function.

| Role | Attributes | What it does |
| --- | --- | --- |
| migration owner | owns the tables | Runs DDL, `bootstrap`, nothing at request time |
| `standfast_app` | `NOLOGIN NOBYPASSRLS` | Group role the API connects through. Granted `SELECT/INSERT/UPDATE/DELETE` per table; `atom_events` gets `SELECT, INSERT` only, because the log is append-only |
| `standfast_auth` | `NOLOGIN NOBYPASSRLS` | Owns `auth.resolve_api_key`, a `SECURITY DEFINER` function with a pinned `search_path`. Holds the one narrow `SELECT` policy on `api_keys` that filters revoked and expired keys |

A deployment creates a login role and grants it `standfast_app`:

```sql
CREATE ROLE standfast_api LOGIN PASSWORD '…' NOBYPASSRLS;
GRANT standfast_app TO standfast_api;
```

`standfast_auth` is the interesting one architecturally: key lookup has to happen
before a tenant exists, which is an exception to "everything goes through
`withActor`". Rather than putting the exception in application code, it is a
`NOLOGIN` role with a policy that can see three columns of one table.
Revocation and expiry are enforced by that policy, not by a `WHERE` clause
someone could later reorder or forget.

### The guard, and why serving as superuser is not a degraded mode

`packages/api/src/serve.ts` calls `assertTenantIsolationApplies()` before it
binds a port. The check (`packages/db/src/guard.ts`) queries `pg_roles` for
`current_user` and refuses to start if `rolsuper` or `rolbypassrls` is true.

The reason this is a startup check and not a warning:

A superuser bypasses row-level security regardless of `FORCE ROW LEVEL
SECURITY`, and so does any role holding `BYPASSRLS`. Connect the API as one and
every policy in `0000_foundation.sql` stops applying. There is no error, no
warning, and nothing in the logs. Requests succeed. Latency is unchanged.
Tests pass. The application behaves perfectly — it simply has no tenancy, and
every request sees every organisation's rows.

Failures that look like health are the ones worth spending a startup check on.
A failure that looks like a failure will be found; this one would be found by a
customer. And it is not hypothetical: `DATABASE_URL=postgres://postgres@…` is
the first connection string anyone reaches for locally, and the first one that
gets copied into a deployment. `docs/02-principles.md` (2) asks for guarantees
a user can attempt to break and watch fail. This is the check that makes the
failure loud.

Migrations still run as the owner. Only the API needs the restricted role.

## Jobs

**Not implemented.** pg-boss is a declared dependency of `db` and `worker`;
nothing imports it, and `packages/worker/src/index.ts` is an empty entrypoint.
The design below is settled in `CLAUDE.md` and recorded here so the first
implementation does not have to rediscover it.

Jobs live in Postgres, and **enqueue is transactional**: the job row is
inserted in the same transaction as the row that justifies it. There is no
intermediate state where a document was stored and its extraction was never
queued, or where extraction was queued for a document whose write rolled back.

This is the whole reason the queue is pg-boss rather than Redis, SQS or any
external broker. An external broker cannot participate in a Postgres
transaction, so you get the two-writes problem permanently and pay for it with
reconciliation jobs, outbox tables and a class of bug that only appears under
load. A Postgres-backed queue makes the problem not exist. The cost — the
queue competes with the application for the same database — is real and
smaller.

### Why the read path has no generative model call

Everything expensive is on the worker side of the queue: extraction (phase 1),
atom embedding (phase 1), and the LLM adjudication used only in the
intermediate deduplication band (`docs/00-handoff.md`). None of it sits between
an agent's question and its answer.

Two things do, and `docs/06-retrieval.md` names them rather than hiding them:
embedding the caller's query, and the cross-encoder reranker. Both are pinned,
bounded and reproducible — the properties `docs/02-principles.md` (4) exists to
protect. Neither generates text. The distinction is load-bearing, so the
heading says *generative* and not merely *model*.

That is `docs/02-principles.md` (4), and it is a contract rather than a
preference for a concrete reason: `context` is called on every session start
through a hook, whether or not the model chose to. A tool that fires
automatically and takes a model call's worth of latency and cost is a tool
users switch off, and the ones who switch it off are the ones whose agents most
needed it. Token budget and p95 latency are the product.

## Deployment shape

Postgres is Neon (`docs/00-handoff.md`: database branching pays for itself when
testing extraction migrations). Neon provides no auth, so authentication is
ours, and RLS keys on a transaction-scoped GUC rather than a vendor's
`auth.uid()` — which is what keeps the AGPL server self-hostable on any
Postgres.

Two connection strings, and they are not interchangeable:

| Variable | Endpoint | Used by |
| --- | --- | --- |
| `DATABASE_URL` | pooled (`…-pooler.…`) | `packages/api`, `packages/worker` |
| `DIRECT_URL` | direct | `drizzle-kit` migrations, `bootstrap` |

The pooler multiplexes connections and does not hold the session state that
some DDL and advisory locks require. Migrations run against the direct
endpoint; the application runs against the pooled one.

**This distinction bites only in production, which is what makes it worth
documenting.** Locally the two strings are the same string, so a developer who
never sets `DIRECT_URL` sees everything pass. `drizzle.config.ts` reads
`DIRECT_URL ?? DATABASE_URL` and `bootstrap.ts` does the same, which is
correct for local use and means a Neon deployment that forgets `DIRECT_URL`
runs its migrations through the pooler and fails in a way that does not name
the cause.

The pooled endpoint is also why `withActor` uses transaction-scoped settings
rather than session-scoped ones. Under a pooler, "session" is not a request.

## Considered and declined

Recorded so the question is asked once.

- **One package instead of seven.** The licence line has to be a directory
  line. See above.
- **A shared types package.** One module, two licences, an argument per commit.
- **A hand-written SDK.** Two descriptions of one contract, drifting quietly.
- **MCP server connecting straight to Postgres.** Ships AGPL code to the
  customer and moves tenancy enforcement into a process we do not control.
- **An external job broker.** Cannot join the Postgres transaction.
- **Authenticating `/health`.** A health check nothing can call is not a health
  check.
- **Writing `last_used_at` on every authenticated request.** It turns every
  read into a read-write transaction, for a column with no consumer in phase 0.
- **A password KDF for API keys.** Keys are 256 bits from a CSPRNG; there is no
  dictionary attack for argon2 to slow down, and p95 latency is a contract.
  SHA-256, compared by an indexed equality inside Postgres.
- **An unauthenticated endpoint that mints the first credential.** `bootstrap`
  is ops tooling over the owner connection. "Only when the table is empty" is a
  race, not a guard.

## Open

- **Where the sync daemon lives** (`docs/10-sync-daemon.md`). It runs on the
  customer's machine, so it is Apache-licensed and must not import `db`. It is
  also the only client-side component with a write path into documents. Own
  package or a mode of the CLI is undecided.
- ~~**Whether `worker` is a separate process**~~ — **settled in phase 1c: a
  separate process**, `packages/worker/src/main.ts`. pg-boss would have run
  in-process happily enough. The argument that decided it is not scaling but
  shape: extraction holds a model call open for seconds at a time, and a
  process sized for that is not a process sized for a request that has to
  answer inside a p95. Sharing one would also land a poison job's memory
  pressure on the read path, which is the path with a latency contract.
- **Whether reconciliation findings arrive over the same `/v1` surface** or a
  distinct ingest path with a narrower schema. `docs/07-reconciliation.md`
  owns it. The wire allowlist constrains the answer either way.
- ~~**Pagination.**~~ **Closed.** Every list endpoint takes `limit` and
  `offset`, capped at 200, and returns an envelope carrying `total`, `returned`
  and `truncated`. The cap that used to sit in `packages/mcp/src/server.ts` is
  gone: `status` reads an aggregate instead of counting atoms it downloaded, so
  there is no scan to limit. `docs/14-roadmap.md` records what that cap was
  getting wrong.

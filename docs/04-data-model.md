<!-- docs/04-data-model.md -->
# Data model

> **Status: settled for phase 0.** Tables, keys and constraints below are
> implemented in `packages/db` and migration `0000_foundation`. Anything
> concerning embeddings, extraction or reconciliation is named here only where
> the phase 0 schema has to leave room for it, and is not implemented.

## The rule this model exists to enforce

`docs/01-thesis.md` says the three invariants are enforced *"in the schema and
in the database, not promised in a policy."* This document is where that claim
is cashed. Every invariant below has a mechanism that makes the violation
**fail**, and a test in `packages/db` that attempts the violation.

A constraint that lives only in application code is not enforcement. It is a
convention with better marketing.

## Tenancy

Every row carries `org_id`. A solo user is an org with one member — teams
(phase 5) then become adding rows to `actors`, not re-keying eight tables and
rewriting every policy against live customer data.

Row-level security keys on a transaction-scoped GUC:

```sql
select set_config('standfast.org_id',   $1, true);   -- true = transaction-local
select set_config('standfast.actor_id', $2, true);
```

Policies read `nullif(current_setting('standfast.org_id', true), '')::uuid`. Both
layers are load-bearing:

- the `true` argument makes a setting that was never defined return `NULL`
  rather than raise;
- `nullif(…, '')` handles the case that actually bites. Once a GUC has been set
  on a connection — even transaction-locally — the placeholder survives the
  transaction with an **empty string** value rather than disappearing. Without
  the `nullif`, the next query on that pooled connection evaluates `''::uuid`
  and raises `invalid input syntax for type uuid`.

`org_id = NULL` is never true, so **an unset GUC returns zero rows, not every
row**. Failing closed is the entire point. The test asserts it on a connection
that has already served another transaction, because that is the only state in
which the empty-string case appears — a first-query-on-a-fresh-connection test
would pass without the `nullif` and prove nothing.

`packages/db` exposes no raw pool. The only way to get a connection is
`withActor(orgId, actorId, fn)`, which opens a transaction, sets both GUCs and
runs the callback. A raw pool export would be a way to accidentally bypass RLS,
so there isn't one.

### Roles

| Role | Purpose |
| --- | --- |
| owner (migration role) | owns the tables, runs DDL |
| `standfast_app` | `NOLOGIN` group role the API connects through. No `BYPASSRLS`. |
| `standfast_auth` | `NOLOGIN`, no `BYPASSRLS`. One job: resolve an API key before any org is known. |

`standfast_auth` exists because authentication is a chicken-and-egg problem under
RLS. Every policy keys on `standfast.org_id`, and the org is not known until the key
is resolved — so the lookup cannot run under a tenant. The answer is a role
*inside* RLS rather than a bypass around it: `0001_auth.sql` gives `standfast_auth`
a single `SELECT` policy on `api_keys`, restricted to rows that are neither
revoked nor expired, and a `SECURITY DEFINER` function `auth.resolve_api_key`
with a pinned `search_path` that returns exactly `(org_id, actor_id, scopes)`.
It can read no other table and no other column.

Every table gets `ENABLE ROW LEVEL SECURITY` **and `FORCE ROW LEVEL SECURITY`**.
Without `FORCE`, the table owner bypasses every policy silently — a test suite
connecting as the owner then passes while protecting nothing. A test asserts
`relforcerowsecurity` on every table.

Superusers bypass RLS regardless of `FORCE`. Integration tests therefore
connect as a non-superuser that has been granted `standfast_app`.

## Tables

### `orgs`
`id uuid pk`, `name text not null`, `slug text not null unique`,
`created_at timestamptz not null default now()`.

### `actors`
`id uuid pk`, `org_id uuid not null → orgs`, `kind actor_kind not null`,
`display_name text not null`, `created_at`.

`kind` is `'human' | 'agent'`. Carries `unique (id, kind)` — not redundant: it
is the target of a composite foreign key that makes "only a human ratifies" a
database constraint. See *Provisional by default* below.

### `api_keys`
`id uuid pk`, `org_id`, `actor_id → actors`, `prefix text not null`,
`hash text not null`, `scopes text[] not null default '{}'`,
`expires_at timestamptz`, `revoked_at timestamptz`, `last_used_at timestamptz`.

The key itself is never stored. `prefix` is the displayable first bytes so a
user can identify a key in a list; `hash` is what is compared. Unique on
`(org_id, prefix)`.

### `projects`
`id uuid pk`, `org_id`, `name text not null`, `slug text not null`,
`created_at`. Unique on `(org_id, slug)`.

### `documents`
`id uuid pk`, `org_id`, `project_id → projects`, `path text not null`,
`title text`, `body text not null`, `content_hash text not null`,
`created_at`, `updated_at`. Unique on `(org_id, project_id, path)`.

The Markdown body lives in a `text` column. One store, one backup, one RLS
policy covering content, and — from phase 2 — a `tsvector` column and a
`pg_trgm` index over it in place. Today `0000_foundation.sql` installs the
`vector` and `pg_trgm` extensions and creates no index that uses either; the
string `tsvector` appears nowhere in `packages/`. The extensions are installed
early because adding one later means a superuser on a live database, which is
the thing worth avoiding, not the index.

Postgres TOASTs large values; splitting content into object storage would add a
second access-control system and a way for content to outlive the row that
governs it.

Documents are the source. Atoms are a projection of them (invariant 1), which
is why the body is not optional and not elsewhere.

### `document_sections`
`id uuid pk`, `org_id`, `document_id → documents on delete cascade`,
`ordinal int not null`, `heading_path text[] not null`, `body text not null`,
`section_hash text not null`. Unique on `(document_id, ordinal)`.

`section_hash` is the unit of incremental extraction: a document edit
re-extracts only the sections whose hash moved. Phase 0 populates sections; it
does not extract from them.

### `atoms`
`id uuid pk`, `org_id`, `project_id`, `document_id → documents on delete
cascade`, `section_id → document_sections on delete cascade`,
`statement text not null`, `kind atom_kind not null`,
`status atom_status not null default 'provisional'`,
`source_quote text not null`, `source_span int4range not null`,
`ratified_by uuid`, `ratified_by_kind actor_kind`, `ratified_at timestamptz`,
`superseded_by uuid → atoms`, `created_at`.

No embedding column in phase 0. The `vector` extension is created by migration
`0000` anyway — see *Extensions*.

#### `atom_kind`

Three values, ordered by how much force they carry. The ordering is not
decorative: `docs/07-reconciliation.md` declines a severity field on findings
*because* the kind already supplies one, so this is where that ordering is
defined.

| Kind | What it is | A violation means |
| --- | --- | --- |
| `constraint` | must hold; breaking it is a defect | the code is wrong |
| `decision` | a choice made deliberately, with alternatives rejected | the code diverged from a choice someone made on purpose |
| `convention` | how this project prefers to do a thing | the code is inconsistent |

`constraint` is the strongest and `convention` the weakest. Extraction
(`docs/05-extraction.md`) must pick one for every atom, and the choice is a
judgement a human ratifies along with the statement.

#### Atom lifecycle

`atom_status` has four values and `atom_event` has four, deliberately close but
not identical: the status is where an atom *is*, the event is what *happened*.

| From | To | By what | Exists today |
| --- | --- | --- | --- |
| — | `provisional` | `POST /v1/projects/{projectId}/atoms`, MCP `propose` | yes |
| `provisional` | `canonical` | ratification, human only | constraint yes, endpoint no |
| `provisional` | `rejected` | ratification, human only | no |
| `canonical` | `superseded` | a successor atom is ratified; `superseded_by` points at it | no |

Two of those four have no route that writes them. `superseded_by` is a column
with no endpoint, `rejected` is a status nothing sets, and
`docs/12-evaluation.md` needs the rejection path or ratification throughput
counts only half the work a reviewer does. `docs/15-ratification.md` designs
the surface that writes all three, and records the one transition this table
cannot express: nothing retires a canonical atom without a successor.

What *is* enforced today is the part that matters most: nothing reaches
`canonical` without a human, and the composite foreign key below is what makes
that unrepresentable rather than merely forbidden.

### `atom_events`
`id uuid pk`, `org_id`, `atom_id → atoms on delete cascade`,
`event atom_event not null`, `actor_id → actors`, `at timestamptz not null
default now()`. Append-only.

`docs/02-principles.md` (5) makes ratification throughput a first-class product
metric. A metric nobody recorded cannot be computed retroactively, so the log
exists from the first migration rather than from the first time someone asks
how the queue is doing.

## The invariants, as constraints

### 1. Atoms are a projection of documents

- `document_id` and `section_id` are `not null`, both `on delete cascade`. An
  atom cannot outlive its source, and cannot be created without one.
- `source_quote text not null` with `check (length(btrim(source_quote)) > 0)`,
  and `source_span int4range not null`. Provenance cannot be skipped, and
  cannot be satisfied with an empty string.

Re-derivability (principle 7) follows mechanically: delete every atom, re-run
extraction, get them back. Nothing is authored only as an atom, because the
schema gives no way to author one without a section to cite.

### 2. Everything an agent writes is born provisional

- `status` defaults to `'provisional'`.
- `check (status <> 'canonical' or (ratified_by is not null and ratified_at is
  not null))` — canonical without a ratifier is unrepresentable.
- `foreign key (ratified_by, ratified_by_kind) references actors (id, kind)`
  plus `check (ratified_by_kind = 'human')`.

The composite key is the interesting half. `actors` is unique on `(id, kind)`,
so a row referencing an agent's id must also claim `kind = 'agent'` to satisfy
the foreign key — and then fails the check. **An agent cannot promote its own
knowledge, and it is the database that says no**, not a code path someone has
to remember to call.

### 3. Source code never leaves the machine

Enforced by allowlist, never denylist (principle 9), applied to the schema.

No table in this model has a column that can hold source. Reconciliation
findings (phase 3) will store `file_path`, `line_start`, `line_end`, `verdict`,
`atom_id` — a verdict and a pointer, per the thesis.

`packages/db/src/schema/wire-allowlist.ts` names the exact column set of every
table whose rows cross the wire. A test reads `information_schema.columns` and
asserts equality with that list. Adding a column fails the test until someone
adds it to the allowlist deliberately, in a diff a reviewer will see. A denylist
would have to anticipate the name of the column nobody thought to forbid.

## Extensions

`0000_foundation` creates `vector` and `pg_trgm`.

The extensions are created in the first migration rather than the one that
needs them, because it costs nothing and proves pgvector is available on the
chosen host on day one, rather than discovering in phase 1 that the retrieval
design does not run where the database lives. `atoms.embedding vector(1024)`
arrived in `0002_extraction_invariants`; no index uses it, and none will before
phase 2.

## Deliberately absent

Embeddings, extraction state, reconciliation findings, ratification queues,
teams and memberships. Each belongs to a later phase, and `docs/14-roadmap.md`
says which — a table added now, ahead of the phase that designs its consumer,
is a table that gets migrated twice.

### Present but unconsumed

Two columns exist that nothing reads. Naming them is cheaper than letting a
reader assume a design behind them.

- `documents.title` — nullable. `standfast doc push` sends `basename(path)`, and
  `docs/11-git-export.md` records that the title is not preserved on export.
  It is a display affordance with no display, and it should either acquire one
  or be dropped.
- `orgs.slug` — `not null unique`, referenced by no endpoint, CLI command or
  document. It anticipates org-scoped URLs, which are a phase-5 concern. The
  uniqueness constraint is the only thing it currently does, and it does that
  correctly, so it stays.

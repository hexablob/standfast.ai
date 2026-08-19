<!-- docs/13-threat-model.md -->
# Threat model

> **Status: designed, not implemented.** The tenancy, authentication and wire
> mitigations below exist in phase 0 and are asserted by tests that run in CI
> today; each one names the file that enforces it. Everything defending the
> instruction channel — the first and most important threat here — is design
> only. `docs/14-roadmap.md` requires this document settled before phase 2
> ships, because phase 2 is the first time an atom enters a session that did
> not ask for it.

## What this document is for

`SECURITY.md` tells a reporter what is in scope and then points here. This is
the document that has to earn that pointer. For each threat it states three
things and keeps them apart: what an attacker **gains**, what **stops them
today**, and what is **still open**.

Three rules govern how it is written.

Nothing is called a mitigation unless the code exists. A threat model that
describes intentions reads exactly like one that describes controls, and the
difference is discovered only by whoever trusted it.

Where a control belongs to a later phase, the phase is named and
`docs/14-roadmap.md` is the schedule. Where nothing has been decided, it goes
to *Open* rather than acquiring a confident sentence.

Severity is not a feeling. It is which invariant is threatened.

| If a report shows | Severity |
| --- | --- |
| Source crossing the wire, or a field that could carry it | Highest. `docs/01-thesis.md`, invariant 3 |
| A path to canonical without a human ratifier | Highest. Invariant 2, and it is persistent |
| A cross-tenant read or write not refused by row-level security | Highest, regardless of what the application layer would have done |
| An atom whose provenance does not resolve to its cited section | High. Invariant 1 is what makes an atom auditable |
| A pin that has silently become mutable | High. `docs/02-principles.md` (12) |
| An agent-authored directive reaching a session unflagged | High from phase 2. Before phase 2 there is no such path |

Report through GitHub's private vulnerability reporting, per `SECURITY.md`.

## What is worth attacking, and who would

| Asset | Why it is worth attacking |
| --- | --- |
| The canonical atom set | It is obeyed, not merely read. One directive here reaches every agent, in every tool, in every future session |
| Another org's documents and atoms | The knowledge base *is* the product. Reading one is reading a company's decisions and the reasoning behind them |
| An API key | It is the whole tenant. No second factor, and scopes are not enforced (see below) |
| The customer's source code | Invariant 3 is the purchase argument. Falsifying it once is worth more to a competitor than any row in the database |
| The published `@standfast/*` packages | `@standfast/mcp` runs inside the customer's agent session, on their machine, with their filesystem |

| Adversary | Capability | Wants |
| --- | --- | --- |
| Hostile co-tenant | A valid key for their own org | Rows belonging to another org |
| Contributor to the customer's docs folder | Can write Markdown that Standfast ingests | A ratified atom that says what they chose |
| Compromised or misaligned agent | Can call `read`, `propose`, `status` | To promote its own writing; to get source across the wire |
| Supply chain attacker | Can publish a package or move a tag | Execution on developer and customer machines |
| Operator error | Full database access, no malice at all | Nothing — which is exactly why the controls have to be automatic |

The last row is not filler. The two loudest failures in this system —
connecting as a superuser, and a column added without a reviewer noticing —
are both accidents, and both have automatic controls precisely because a
careful person is not one.

---

## 1. Knowledge as an instruction channel

`docs/02-principles.md` (13). This is the most interesting threat in the
system and the one specific to it, because the mechanism under attack is the
same mechanism that makes the product worth buying.

A canonical atom is injected into every future agent session. From phase 2 it
arrives without being asked for, through a `SessionStart` hook, in whatever
client the developer happens to be using. It arrives framed as ratified
project knowledge, which is the exact framing that makes a model comply. An
attacker who lands text in one canonical atom therefore has:

- **persistence** — it survives session boundaries and context compaction,
  because it is re-injected rather than remembered;
- **breadth** — Claude Code, Cursor, Codex and Gemini all receive it. The
  cross-tool promise in `docs/01-thesis.md` is also the blast radius;
- **authority** — it is not a stray string in a file the agent happened to
  read. It is the project speaking.

Ordinary prompt injection lasts one session. This lasts until someone notices.

### The paths in

**Through a document.** The widest door, and the one Standfast does not control.
Documents are the source (invariant 1), and they come from the customer's
folder. Anyone who can write Markdown there — a contributor, a generated
README, a dependency that drops a file — is upstream of every atom. Standfast
cannot fix this and should not pretend to: the folder is the working surface
by design (`docs/01-thesis.md`).

**Through the extractor.** Phase 1 runs a model over section text. Text
written to address the extractor rather than the reader is indirect injection
of the classic kind, and the extractor is the one component whose whole job is
to take instructions from documents.

**Through `propose`.** An agent writes a provisional atom. It cannot ratify
it, but it can write a plausible one and put it in a human's queue. This path
attacks the reviewer, not the database.

**Through assembly.** Phase 2 concatenates atom statements into a context
pack. Anything in a statement is then in the instruction position unless the
pack marks it as data — and see the tension below, because marking it as inert
data is not obviously the right answer either.

### Gain

A directive that every agent on the project follows, that no session start
removes, and that reads as though a human signed for it. In the worst case
that directive names an exfiltration destination, disables a check, or
rewrites a security convention into its opposite.

### Stops them today

- **There is no `ratify` tool, and the absence is the design**
  (`docs/08-mcp-server.md`). Not restricted, not scoped — absent, so the MCP
  surface does not suggest the capability exists.
- **The database refuses agent self-ratification.** `atoms` carries
  `foreign key (ratified_by, ratified_by_kind) → actors (id, kind)` alongside
  `check (ratified_by_kind = 'human')`. Claiming `'agent'` fails the check;
  claiming `'human'` for an agent's id fails the foreign key. Both branches are
  asserted in `packages/db/src/testing/rls.integration.test.ts`.
- **`canonical` without a ratifier is unrepresentable.**
  `atoms_canonical_requires_ratification`, also tested.
- **`status` is not a parameter.** `CreateAtomSchema` has no `status` field and
  `createAtom` in `packages/db/src/repositories/atoms.ts` does not accept one.
  The column takes its default. The database would refuse anyway; this is about
  not offering the door.
- **The HTTP `ratify` route returns 403 for an agent actor** after checking
  `getActorKind`. The check is the error message; the constraint is the
  guarantee. Both stay.
- **Provenance is not optional.** `document_id`, `section_id`, `source_quote`
  and `source_span` are all `not null`, with
  `check (length(btrim(source_quote)) > 0)`. The `read` tool returns the source
  quote with every atom, so a reviewer never sees a bare assertion.
- **`propose` says so out loud.** Its description ends *"Only a human can
  ratify it; you cannot"*, and its result carries *"Stored as provisional. A
  human must ratify it before it becomes canonical."* This is not a security
  control against a hostile agent. It is a control against a confused one that
  would otherwise report success it did not achieve, and stop surfacing the
  pending decision to the human — which is the same outcome by accident.

### Still open

**Provenance is asserted, not verified.** The database checks that
`source_quote` is non-blank. Nothing today checks that it actually appears in
the cited section at `source_span`. `createAtom` does not read the section
body. So an agent calling `propose` can attach any quote it likes to any
section. This is precisely the "provenance spoofing" that `SECURITY.md` puts
in scope, and it is unenforced until phase 1, whose first exit criterion is a
whole-database query returning zero atoms whose quote does not verify. Until
that lands, provenance shown to a reviewer is the proposer's claim about
provenance.

**Nothing ties `section_id` to `document_id`.** They are independent foreign
keys. Within one org an atom can cite section *S* while naming document *D*
that *S* does not belong to. Row-level security keeps both inside the tenant,
so this is an integrity problem rather than a disclosure one — but a reviewer
reading provenance is reading two fields that the schema never made agree. A
composite key would fix it; it has not been written.

**The statement is not the quote.** Even after phase 1's verification, only
the quote is checked against the section. The `statement` — the sentence that
is actually injected into sessions — is model output, and a verified innocuous
quote can sit under an injected statement. Whether extraction should require
the statement to be entailed by the quote, and how that is checked, is
undecided. It is a *write*-path check, so a model call is permitted there
(`docs/02-principles.md`, 4, constrains the read path only).

**The flagging heuristic does not exist.** Principle 13 asks for imperative
and meta-instruction patterns to be flagged; `docs/14-roadmap.md` puts that
surface in phase 4. There is no heuristic, no corpus, and principle 10 forbids
tuning a threshold without one. Inventing a pattern list here would be the
exact failure that principle describes.

**Whether the context pack frames atoms as data or as directives**, and this
does not have an obvious answer. Rendering them as inert data would blunt the
injection — and would also blunt the product, because an agent that treats a
convention as trivia rediscovers it by violating one, which is the cold-start
failure Standfast exists to fix. The mitigation cannot be *never treat knowledge
as instruction*. It has to be *the instruction is one a human signed for*,
which pushes the entire weight of the control onto ratification.

**A ratified atom whose section later changes is unanchored.** Editing a
document does not alter atoms already projected from it, so the displayed
provenance can outlive the text it quotes. Whether an edit should demote
affected atoms, or merely mark them stale, belongs with phase 1's
section-hash diffing and has not been decided.

### The tension worth naming rather than hiding

Principle 5 makes ratification throughput a first-class product metric.
Principle 13 makes human ratification the central security control. These pull
against each other: every improvement in throughput is a reduction in the
attention paid per atom, and a queue optimised hard enough becomes a button
someone holds down.

We are not resolving that here, and we are not pretending it away. Two
consequences follow, and both are design constraints on phase 4:

- throughput is measured as *decisions* per unit time, never as *approvals*,
  so the metric cannot be improved by approving faster;
- the reviewing surface shows provenance by default and cannot be configured
  to hide it. A one-click bulk approve over unread provenance would satisfy the
  metric and defeat the control, so it is not built.

---

## 2. Tenant isolation

### Gain

Another organisation's documents and atoms in full: their decisions, their
constraints, the reasoning behind both, and the shape of their project. For a
hosted deployment this is the failure that ends the company.

### Stops them today

Most mechanisms below are in migration `0000_foundation.sql` or in
`packages/db`, and each of those is asserted by a test that attempts the
violation and watches it fail (`docs/02-principles.md`, 8).

Two are not, and the difference matters more than the list does. The start-up
guard is code in `packages/api`, not a constraint, and no test drives its
refusal end to end. The MCP transport boundary is an architectural property —
`packages/mcp` holds no Postgres driver — enforced by nobody but review. Both
are in *Still open* below, and a reader should treat an unasserted mechanism as
a claim rather than a control.

| Mechanism | Defends against | Does **not** defend against |
| --- | --- | --- |
| `org_id` on every row; one isolation policy per table, `TO standfast_app`, with both `USING` and `WITH CHECK` | A query that forgets its own `where org_id`, and a write that parks a row in another tenant's space | A caller that authenticates as the other org |
| `FORCE ROW LEVEL SECURITY` on all eight tables | The table owner reading straight through its own policies — including a test suite that connects as the owner and passes while protecting nothing | A superuser or any role holding `BYPASSRLS`, for which `FORCE` is irrelevant |
| `nullif(current_setting('standfast.org_id', true), '')::uuid` | A forgotten `set_config` returning **every** row instead of none, on a pooled connection where the GUC survives as `''` rather than disappearing | A `set_config` carrying the wrong org id |
| `withActor` as the only route to a connection; `getPool` absent from `index.ts`; the package `exports` map publishes only `.` | Reaching the database by forgetting a wrapper | Code inside `packages/db` itself |
| `assertTenantIsolationApplies()` before the port binds | `DATABASE_URL=postgres://postgres@…` — the first connection string anyone reaches for locally, and the first one copied into a deployment | A role granted `BYPASSRLS` after start-up |
| `GRANT SELECT, INSERT` only on `atom_events` | Rewriting the ratification history that principle 5 turns into a product metric | — |
| The MCP server talks to the API over HTTPS, never to Postgres | Moving the tenancy boundary into a process the customer controls | — |

Two of these deserve a sentence rather than a table cell.

**`FORCE`, not merely `ENABLE`.** Without `FORCE` the owner bypasses every
policy silently. Nothing about the schema looks wrong, and a suite connecting
as the owner keeps passing. `schema-guards.integration.test.ts` therefore
asserts `relforcerowsecurity` directly against `pg_class`, for every table,
because its absence is invisible until it matters.

**The start-up guard is a refusal, not a warning.** A superuser bypasses RLS
regardless of `FORCE`. Connect the API as one and every policy stops applying:
no error, no log line, unchanged latency, green tests. The application behaves
perfectly and has no tenancy. Failures that look like health are the ones worth
spending a start-up check on, because a failure that looks like a failure gets
found, and this one gets found by a customer.

The suite runs as `standfast_test`, a non-superuser `NOBYPASSRLS` login role granted
`standfast_app`. That is not incidental: run it as the superuser the CI service
container provides and every isolation assertion passes for the wrong reason.
The positive control — *sees its own org's documents* — is there for the
mirror-image failure, where broken role membership would deny everything and
make every negative test pass while proving nothing.

### Still open

- **No test asserts the guard's refusal end to end.** `guard.ts` reads
  `pg_roles` for `current_user`, but nothing in CI starts the API under a
  `BYPASSRLS` role and asserts it will not bind a port. The check that makes
  the loudest failure loud is itself the least exercised code in the
  repository.
- **Teams (phase 5) put a second principal inside one org.** Every policy
  today keys on `org_id` alone. Per-project permissions mean a second predicate
  on every policy, and `docs/14-roadmap.md` makes the extended RLS suite a
  phase-5 exit criterion. Until then, "tenant" and "org" are the same word.
- **A compromised migration role owns everything.** It is out of reach of every
  control here by construction. Reducing its blast radius is not designed.
- **Connection poolers.** Transaction-scoped GUCs are what make pooling safe; a
  session-scoped setting would leak one request's tenant into the next request
  served by the same connection. Nothing tests the deployed pooler's mode, and
  a pooler misconfigured into session mode would not announce itself.

---

## 3. Authentication bypass

Resolving an API key has to happen *before* any tenant exists, which is
exactly what row-level security keys on. It is the one query in the request
path outside `withActor`, and therefore the single highest-value target in the
schema.

The obvious shortcut — a `SECURITY DEFINER` function owned by the migration
role — does not work, and it is worth knowing why. Migration `0000` sets
`FORCE ROW LEVEL SECURITY`, and `FORCE` subjects the owner to policies too, so
the definer function would still evaluate `org_id = nullif(…)`, which is `NULL`
during authentication, and would return zero rows every time. The exception
stays *inside* RLS instead: a dedicated `standfast_auth` role, `NOLOGIN
NOBYPASSRLS`, holding one narrow `SELECT` policy on `api_keys` with no org
predicate, because there is no org yet.

`0001_auth.sql` says the fix for a lookup that returns nothing is that policy,
and never dropping `FORCE`. Keep it that way.

### Gain

Any tenant, without a key. `auth.resolve_api_key` returns `(org_id, actor_id,
scopes)`, and those three values are what the rest of the request trusts
completely.

### Stops them today

- **The function owner is `standfast_auth`**, which cannot log in and cannot bypass
  RLS. Nothing else in the system ever runs as it, and what it can see is three
  columns of one table.
- **`search_path` is pinned:** `SET search_path = pg_catalog, public`. This is
  a privilege-escalation control, not a style preference. A `SECURITY DEFINER`
  function executes with its owner's privileges, and with an unpinned
  `search_path` the unqualified names in its body resolve using the *caller's*
  path. Anyone who can create an object in a schema appearing earlier in that
  path can shadow a table, a function or an operator used in the body — and
  their object then runs as the owner. The pin fixes resolution regardless of
  what the caller has set.
- **Revocation and expiry live in the policy**, not in application code:
  `USING (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))`.
  An expired key is *invisible* to the lookup rather than filtered by a
  condition someone could later reorder, wrap in a helper, or forget.
- **`REVOKE ALL … FROM PUBLIC`**, then `GRANT EXECUTE` to `standfast_app` alone.
- **One error message.** `requireApiKey` returns *"Invalid API key"* for
  absent, revoked, expired and wrong alike. Distinguishing them tells an
  attacker which of their guesses was once real.

### Still open

- **`pg_temp` is not listed in the pinned path.** Postgres searches the
  temporary schema ahead of the listed schemas for relation names when it is
  not explicitly placed, so the convention is to list it last. Here the body
  names `public.api_keys` in full, which resolves regardless — but the
  qualification is doing that work, not the pin, and an edit that drops the
  qualification would reopen the hole silently. Appending `pg_temp` costs
  nothing and has not been done.
- **`scopes` is resolved and never enforced.** `resolveApiKey` returns it,
  `requireApiKey` sets it on the Hono context, `bootstrap` writes
  `['read','write']`, and **no route reads it**. A read-only key today is a
  read-write key. This is a gap, not a design: the column and the plumbing
  exist so that enforcement is an addition rather than a migration, but until a
  route checks it, the word "scoped" should not appear in any description of
  Standfast's keys.
- **`api_keys.hash` has no index and no unique constraint.** The lookup is a
  sequential scan on every authenticated request, and `LIMIT 1` resolves a
  duplicate arbitrarily. The comment in `packages/db/src/auth.ts` justifying
  SHA-256 describes the lookup as "an indexed equality comparison inside
  Postgres"; migration `0000` creates indexes on `(org_id, prefix)` and
  `actor_id` only. The security argument survives — turning a timing signal
  into a key still means constructing a preimage — but the sentence is
  currently wrong and the index should exist.
- **No rate limit anywhere.** Nothing throttles authentication attempts. It
  does not help against a 256-bit key, and it does help against everything else
  on the same surface.

---

## 4. API key handling

### Gain

The tenant, entire. There is no second factor.

### Stops them today

A key is `sf_sk_` followed by 32 bytes from `randomBytes`, base64url. Only
its SHA-256 hex digest is stored; `prefix` holds enough leading characters to
identify a key in a list and is useless alone. `bootstrap` prints the key once
and says that it will not be shown again.

**SHA-256, not argon2 or bcrypt**, and the reasoning is recorded so the
question is asked once. The key is 256 bits from a CSPRNG, so there is no
dictionary and no guessing attack for a slow KDF to slow down. What a slow KDF
would reliably do is add tens of milliseconds to every authenticated request,
and p95 latency is a contract (`docs/02-principles.md`, 4). A password KDF here
would buy nothing and cost something on every call.

**No `timingSafeEqual`**, for a related reason: the comparison is an equality
predicate evaluated inside Postgres, not a byte loop in JavaScript, so there is
no place for it to apply. The residual timing channel reveals something about
where a digest sits in a table, and converting that into a key means
constructing a SHA-256 preimage.

**Bootstrap is ops tooling, not an endpoint.** It runs over the owner
connection. An unauthenticated route that mints the first credential is an
unauthenticated route that mints credentials, and "only when the table is
empty" is a race, not a guard.

**`last_used_at` is deliberately not written** on each request: a write on
every authenticated call turns every read into a read-write transaction, for a
column with no consumer in phase 0.

### Still open

- **A stolen key leaves no trail.** Because `last_used_at` is never written,
  nothing distinguishes a key in normal use from one being used from somewhere
  else. When there is a consumer for that signal the cost calculation above
  changes, and it should be redone rather than inherited.
- **No rotation workflow.** `revoked_at` and `expires_at` are enforced by the
  policy, and no command sets either. Revocation is currently a manual
  `UPDATE`.
- **The key sits in `STANDFAST_API_KEY`** in a client's MCP configuration, in
  plain text, on the developer's machine, readable by everything that runs
  there — including agents. Reducing that exposure is not designed.

---

## 5. Source code exfiltration

Invariant 3 is the one most worth attacking, because it is the reason someone
buys this rather than writing a Markdown file. Making it false once is worth
more than any row in the database.

### Gain

The customer's source, or — nearly as damaging — a demonstration that it can
leave. Standfast's claim is that reconciliation runs inside the customer's own
agent session and that what returns is a verdict and a `path:line`. A single
counter-example converts a founding invariant into marketing.

### Stops them today

**There is no representation of source code to leak.** No contents, no AST, no
call graph, no file tree — excluded, not deferred (`docs/14-roadmap.md`). No
column in any of the eight tables can hold one.

**`packages/db/src/schema/wire-allowlist.ts` names the exact column set** of
every table whose rows cross the wire, and
`packages/db/src/testing/schema-guards.integration.test.ts` reads
`information_schema.columns` and asserts **equality**, not containment. Adding
a column fails the build until someone adds it to the allowlist too, in a diff
a reviewer sees, with a commit message that has to justify it.

**Allowlist, never denylist** (`docs/02-principles.md`, 9). The two fail
differently, and the difference is the whole argument. A denylist fails open:
it has to anticipate the name of the column nobody thought to forbid, so the
column that gets through is by definition the one nobody considered. An
allowlist fails closed: its failure mode is a legitimate column blocked until
someone writes it down, which is a red build during review rather than a
disclosure in production. The first failure is silent and permanent; the second
is loud and costs ten seconds.

**No MCP tool returns source, because there is no tool for it**
(`docs/08-mcp-server.md`). And no MCP tool *writes documents*: the customer's
folder is the write path, so an agent has no sanctioned route for putting
arbitrary text into a **document**.

Do not overread that. `propose` is a sanctioned route for putting arbitrary
agent-authored text into an **atom** — `PROPOSE_INPUT` takes a free-text
`statement` and `source_quote`, and `createAtom` stores both without reading
the section they claim to come from. That is the whole reason every proposed
atom is born `provisional` and the whole reason quote verification is a phase-1
exit criterion. The distinction between the two write surfaces is the design;
collapsing them into "agents cannot write" would be a comfortable lie.

**The CLI's `export` refuses a server-supplied path that escapes its target
directory** — `resolve`, then `relative`, then reject on `..`, on a leading
separator, and on the empty string. That is the mirror-image problem, a hostile
server writing outside the directory the customer named, and it is tested.

### Still open

- **Allowed text columns still hold text.** `documents.body`,
  `atoms.statement` and `atoms.source_quote` are free text by necessity —
  documents are the source. Someone determined to put source code into Standfast
  can paste it into a Markdown file. The allowlist stops a *field* from
  escaping; it cannot stop a human from typing. The honest boundary is that
  Standfast never *asks for*, *reads*, or *transmits* source on its own, and the
  absence of a document write path over MCP is what stops an agent doing it on
  the human's behalf.
- **The `reconcile` rationale field is the recognised hole.** Phase 3 gives it
  the only free-text field on the reconciliation path, which makes it the only
  place an agent could paste code into a system whose third invariant forbids
  it. `docs/14-roadmap.md` caps its length, validates it harder than anything
  else in the schema, and leaves open whether a length cap is sufficient or
  whether free text has no place on that path at all. This document does not
  close that question. It records that the field is the hole, and that removing
  it entirely stays on the table.
- **The findings table does not exist yet.** Its columns join the allowlist in
  the same diff that creates them, which is a phase-3 exit criterion and not a
  present-tense guarantee.

---

## 6. Supply chain

`docs/02-principles.md` (12): pin, sign, attest, and never execute the latest
published version at every start-up.

### Gain

Execution on a developer's machine and, through `@standfast/mcp`, inside a
customer's agent session with their filesystem. This is the highest-leverage
attack in the list, and it does not require touching Standfast's servers at all.

### Stops them today

- **Every GitHub Action is pinned by commit SHA**, not by tag, in
  `.github/workflows/ci.yml`. A tag is mutable, and a supply chain that can be
  moved under you is not pinned.
- **The Postgres service image is pinned by digest**
  (`pgvector/pgvector:pg16@sha256:…`).
- **`onlyBuiltDependencies: [esbuild]`** in `pnpm-workspace.yaml`. pnpm 10 runs
  no dependency lifecycle script unless it is listed, and an unreviewed
  `postinstall` is the cheapest supply-chain foothold there is. The list has
  one entry and stays short deliberately.
- **`provenance=true`** in `.npmrc`, so releases publish with npm provenance
  attestations.
- **`engine-strict=true`**, refusing to install on an unsupported Node rather
  than failing later and oddly.
- **`pnpm install --frozen-lockfile`** in both CI jobs.
- **`permissions: contents: read`** as the workflow default.

### The Supermemory plugin, since a reader will ask

Supermemory runs as a Claude Code plugin for sessions on this repository. It is
developer tooling — session recall for whoever is working on Standfast, scoped to
its own container. It is not a workspace dependency, is never imported by
product code, and never receives customer source, documents or atoms. Its
credential lives in the developer's shell environment rather than a project
`.env`, because a key in the project tree implies a runtime dependency that
does not exist. Routing any part of the knowledge layer through a hosted memory
service would break invariant 3, which is why `CLAUDE.md` forbids adding a
hosted memory or retrieval SDK to any workspace package.

### Still open

- **A pin freezes; it does not verify.** Nothing checks that a pinned SHA is
  the commit it claims to be, or reviews what changes when one is bumped.
- **No dependency audit gate and no SBOM.** Neither is in CI.
- **The release job does not exist.** `docs/14-roadmap.md` makes "a release job
  that fails on an unsigned or unattested artifact" a phase-4 exit criterion.
  `provenance=true` describes what will happen when something publishes;
  nothing publishes yet. `SECURITY.md` says releases publish with provenance
  attestations — true of the configuration, not yet true of any release.
- **Nothing detects a pin that has become mutable**, which `SECURITY.md`
  explicitly puts in scope. Today that detection is a human reading a diff.

---

## 7. Hosted versus self-hosted

The same code, two different threat models. Conflating them is how a control
that matters in one gets removed for being pointless in the other.

| | Self-hosted | Hosted |
| --- | --- | --- |
| What RLS defends against | Application bugs. One org, so there is no hostile co-tenant to keep out | Another paying customer. It is the only thing standing between two tenants |
| Consequence of a `BYPASSRLS` role | A policy that was never load-bearing stops applying | Every request sees every organisation's rows |
| Who holds the database | The customer. Operator and tenant are the same person | Us. The tenant is not the operator and cannot audit the operator |
| Most likely failure | `DATABASE_URL=postgres://postgres@…` copied out of a quickstart | A migration or a policy change reviewed in a hurry |
| Invariant 3 | Identical. The wire allowlist is code, not configuration | Identical, and it is why the boundary is testable rather than contractual |
| Licence pressure | AGPL-3.0-only for `api`, `core`, `db`, `worker` | The same copyleft obliges our own hosted version to publish its modifications, so a quietly weakened policy is not something we can ship |

The start-up guard is worth more in the self-hosted case than in the hosted
one, which is the opposite of how these things usually go. A hosted deployment
has a reviewed connection string and a controlled role; a self-hoster reaches
for the superuser their Postgres already handed them. The control exists for
the deployment where the failure is invisible, and it is unconditional rather
than a warning because a warning in a first-run log is a warning nobody reads.

### Still open

- **No hosted deployment exists.** Everything in the right-hand column is
  reasoning about a system that has not been operated. None of it has met a
  real multi-tenant workload.
- **No customer-facing audit view.** `atom_events` is append-only, per-org, and
  has existed since migration `0000` precisely so this is not a metric started
  from zero — but nothing surfaces it. Phase 5.
- **No incident process** beyond the reporting route in `SECURITY.md`, and no
  stated disclosure timeline past the three-working-day acknowledgement.
- **No key rotation, and no way for a customer to enumerate their own keys**
  through the API.

---

## Egress — what leaves Standfast, and to whom

Everything above defends the **inbound** direction: what a caller may put in,
what the wire allowlist lets back out, which tenant a row belongs to. That is
the direction an attacker pushes on. It is not the direction a customer's
lawyer asks about.

Standfast's purchase argument is a boundary claim — *source code never leaves the
machine*. The claim is true and the schema enforces it. But invariant 3 is
about **source code**, and by phase 2 this system could transmit five other
things to endpoints it does not own. No entry in this model covered them until now,
and `docs/06-retrieval.md` explicitly routed the question here.

| What leaves | To whom | Phase | Contains |
| --- | --- | --- | --- |
| Section prose | extraction model provider | 1 | whatever the customer wrote in their docs |
| Atom text and section prose | embedding provider | 1 | the same, plus derived statements |
| Two atom statements | dedup judge, intermediate band only | 1 | derived statements, no prose |
| **The developer's live query** | query embedder | **2** | *what someone is working on, right now* |
| **The developer's live query, plus candidate atoms** | reranker | **2** | *the same, plus what we think governs it* |

The last two rows are different in kind, and they are the ones to be careful
about.

Rows one to three send **stored prose the customer deliberately uploaded**.
They are batch, they are on the worker side of the queue, and they carry no
timing signal. Rows four and five send a **task description typed minutes
ago**, on the read path, in real time. An observer holding that stream learns what a team is
building before the team ships it. That is not source code, so invariant 3 is
untouched — and it is still the most sensitive thing this system will ever put
on a wire.

**Rules.**

1. **Named endpoints only.** Every outbound destination is a configured
   allowlist entry with a pinned model version. A provider that is not on the
   list is not called, and the failure is a start-up refusal, not a fallback.
   This is the outbound counterpart to `wire-allowlist.ts`, and it does not
   exist yet.
2. **The read path is stricter than the write path.** A model that sees stored
   prose in a batch job is one procurement decision. A model that sees live
   queries is another, and it needs its own consent. Reranking must be
   operable **in-region and under our own control** — one of the five
   conditions `docs/06-retrieval.md` already states — precisely so that row
   four can be satisfied without a third party at all.
3. **Egress is disclosable.** A customer can ask what left, to which provider,
   for which project. If the answer requires reading code, the answer is not
   good enough.
4. **Self-hosting must be able to reach zero.** The AGPL server has to be
   runnable with every outbound call pointed at something the operator runs.
   A design that only works against a hosted provider makes the open-source
   half a demo.

**Where this stands.** Phase 1d opened the first outbound socket in this
repository, and three of the four rules landed with it.

Rule 1 is `packages/core/src/egress.ts` and the `admitEgress` call in each
adapter's constructor. A destination the allowlist does not name cannot be
reached, and the refusal is a start-up failure rather than a fallback. The
check is in two places on purpose: `resolvePorts` fails at boot with a message
naming the configuration, and the constructors make the same destination
unreachable from any other wiring — a test, the evaluation harness, whatever
phase 2 builds.

Rule 2 is `PERMITTED_PURPOSES`, which refuses `reranking` outright. It cannot
be switched on by adding a line to a phase-1 deployment's configuration.

Rule 3 is `egress_events`: one row per outbound call, recording the project,
the section, the purpose, the destination, the pinned model and the size of
what was sent. The row is written *before* the request, so a record that
cannot be written is a request that is not made. No column can hold prose —
the log measures what left and never copies it. It is append-only by grant:
`standfast_app` holds SELECT and INSERT and nothing else. It is read through
`GET /v1/projects/{projectId}/egress`, grouped by the triple the allowlist
pins, and `…/egress/events` for the individual calls — `standfast egress
--project <id>` on the command line. Not an MCP tool: the six in
`docs/08-mcp-server.md` serve an agent working on a file, and this is a
question a person asks about the deployment.

Rule 4 is admitted and not exercised. The allowlist accepts a plaintext origin
on a local or private host precisely so that a self-hosted model is reachable,
and nothing here has been run against one.

## Deliberately out of scope

Recorded so each question is asked once.

- **The customer's machine.** Their agent, their editor, their filesystem,
  their shell history. Standfast runs there as an MCP server and cannot be the
  security boundary for the environment it is a guest in.
- **A provider's internal handling of prose we have already sent it.** Retention,
  sub-processors, jurisdiction: procurement questions, answered by contract, not
  threats this model can close. *What* we send them is very much in scope — see
  *Egress* above, which this bullet used to swallow by accident.
- **Denial of service**, beyond noting that no rate limit exists. There is no
  availability commitment to threaten.
- **Physical and host security of the database provider.**
- **Findings in third-party dependencies**, which go upstream first — tell us
  too if Standfast's use of them makes the impact worse (`SECURITY.md`).

## Open

Consolidated, so the list can be worked rather than re-derived.

**Before phase 1 ships**

- Verbatim quote verification, without which provenance is an assertion.
- Whether `(document_id, section_id)` should be a composite key, so provenance
  cannot name two things that disagree.
- Whether extraction should constrain the statement to be entailed by the
  quote, and how that would be checked.

**Before phase 1d ships**

- ~~**The outbound allowlist**~~ — **built in phase 1c**, ahead of the adapters
  it governs, in `packages/core/src/egress.ts` and asserted at the worker's
  start-up. Rule 1 is enforced: one destination per purpose, an exact origin
  and an exactly pinned model, a floating alias refused, and a purpose with no
  entry refused. Rule 2 is enforced by refusing a `reranking` entry outright.
  Rule 4 is satisfied by admitting plaintext to a host the operator runs and
  nowhere else. Rule 3 has its static half — `describeEgress` prints what a
  deployment would send and to whom, at start-up, so the question needs no
  source file. ~~**What remains of rule 3**~~ — the per-project record of what
  actually left and when — **shipped in 1d** as `egress_events`, written by the
  handler before each port call and only for ports that open a socket, and read
  over `GET /v1/projects/{projectId}/egress` or `standfast egress`.
  The reasoning that moved it here, kept because it is the record: this was
  scheduled for phase 2 on the grounds that phase 2 is the first phase to send
  a developer's live query off the machine. That argument is about the payload;
  rule 1 is about the destination, and the *Egress* table above already lists
  three phase-1 flows. Retrofitting a start-up refusal onto a worker that
  already shipped is a breaking configuration change for every deployment that
  worked without one, so it landed in 1c — one phase ahead of the adapters
  rather than one behind them.

**Before phase 2 ships** — the phase `docs/14-roadmap.md` gates on this
document

- Whether the context pack frames atoms as data or as directives, given that
  neither answer is free.
- What an imperative or meta-instruction pattern is, measured on a corpus that
  does not exist yet (`docs/02-principles.md`, 10).
- Whether an atom should be demoted or marked stale when its section changes.
- **Whether reranking runs in-region under our own control**, or whether a
  third-party reranker is acceptable and under what consent
  (`docs/06-retrieval.md`, condition 2).

**Before phase 3 ships**

- Whether a length cap is sufficient protection for the `reconcile` rationale
  field, or whether free text has no place on that path.

**Before phase 4 ships**

- The release job that fails on an unsigned or unattested artifact.
- A ratification surface whose throughput cannot be improved by reading less.

**Unscheduled, and each of them cheap**

- Enforce `scopes`, or stop calling the keys scoped.
- Index `api_keys.hash`, and correct the comment in `packages/db/src/auth.ts`.
- Append `pg_temp` to the pinned `search_path` in `auth.resolve_api_key`.
- A test that starts the API under a `BYPASSRLS` role and asserts it refuses.
- A rate limit on the authentication path.
- A key rotation and revocation command in the CLI.

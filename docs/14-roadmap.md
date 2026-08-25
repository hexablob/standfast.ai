<!-- docs/14-roadmap.md -->
# Roadmap

> **Status: phases 0 to 3 are built; phase 0 is the only one that has exited.**
> Every phase-0 exit criterion below is checked in CI today. Phase 1 has shipped
> its schema, its evaluation harness, its pipeline and its adapters. Phase 2 has
> shipped its machinery — indexes, the four generators, fusion, assembly,
> `context` and `search`. Phase 3 has shipped migration `0009`, the findings
> tables, the `reconcile` tool — the sixth and last the specification names —
> the `PostToolUse` hook, drift counts through `status` and the CLI `findings`
> commands; migration `0010` then closed org-consistency across the whole schema
> with composite foreign keys. None of the three **can exit on that**, because
> all three wait on the same thing: a labelled corpus, written blind by a human,
> that does not exist. Phases 4 and 5 are decided as scope and as ordering and
> neither has started; what exists of phase 4 is vocabulary rather than
> behaviour, in migrations `0011` and `0012`, and nothing writes either yet. The
> phase numbers are a contract — `CLAUDE.md` and `docs/00-handoff.md` cite them
> — so they are not renumbered, ever.
>
> **Machinery is not a phase.** Recording that distinction here because it is
> the one this document exists to enforce: a phase exits on a number somebody
> measured, not on the code that would produce it. Phase 2's constants — k=60,
> λ≈0.7, the candidate caps, `ef_search` — are all in use and all still the
> defaults they arrived as. Criterion 5 is the one that says so out loud.

## What a phase is

A phase is a slice that leaves the product coherent when it lands. Each one
below states three things, and they are not the same thing:

- **Scope** — what is built.
- **Done** — the sentence a user could say afterwards that they could not say
  before. If nothing changes for a user, the phase was a refactor.
- **Exit criterion** — something a machine can check. "Extraction works well"
  is not an exit criterion. "Zero stored atoms whose quote does not verify
  against its section" is.

Where an exit criterion needs a number that nobody has measured yet, it says
so and the number goes to *Open*. A roadmap that invents thresholds is a
roadmap that will be quietly ignored the first time reality disagrees with it.

## The phases

`docs/01-thesis.md` says we will know this works by four numbers. Each of the
four belongs to exactly one phase, and that phase owns it.

| Phase | Scope | Owns | State |
| --- | --- | --- | --- |
| 0 | foundation: schema, auth, CRUD, SDK, CLI, three MCP tools | — | **complete** |
| 1 | extraction: documents become provisional atoms | extraction precision | **under way** |
| 2 | retrieval: `context` and `search` under a token budget | retrieval precision under budget | **under way** |
| 3 | reconciliation: verdicts on whether code honors atoms | reconciliation false-positive rate | not started |
| 4 | distribution and the ratification loop | ratification throughput | not started |
| 5 | teams | nothing new; nothing may regress | not started |

Phase 5 owning no number is deliberate. Teams multiply usage of a system whose
quality is already established; if a team feature moves one of the four
numbers, it moved it downwards.

## Phase 0 — foundation (complete)

Everything listed here was read out of the repository, not out of a plan.

**Monorepo.** pnpm workspaces and Turborepo over seven packages — `api`,
`cli`, `core`, `db`, `mcp`, `sdk`, `worker`. Biome for lint and format, Vitest
for tests, TypeScript project references built with `tsc -b`. CI pins every
GitHub Action by commit SHA, because a tag is mutable and a supply chain that
can be moved under you is not pinned (`docs/02-principles.md`, 12).

**Schema.** Migrations `0000_foundation` and `0001_auth`, each with a
hand-written `.down.sql`. Eight tables: `orgs`, `actors`, `api_keys`,
`projects`, `documents`, `document_sections`, `atoms`, `atom_events`. Every
one carries `ENABLE` **and `FORCE ROW LEVEL SECURITY`** and a single
org-isolation policy scoped to `standfast_app`, a `NOLOGIN NOBYPASSRLS` role.
`packages/db` exports no raw pool: `withActor(orgId, actorId, fn)` is the only
way to a connection. `vector` and `pg_trgm` are created now, with no column
using them, to prove pgvector exists on the chosen host before phase 1 depends
on it.

**The invariants as constraints.** `atoms.document_id` and `section_id` are
`NOT NULL` and cascade; `source_quote` is `NOT NULL` with a non-blank check; a
composite foreign key on `(ratified_by, ratified_by_kind)` into
`actors (id, kind)` plus `check (ratified_by_kind = 'human')` makes an agent
promoting its own knowledge unrepresentable rather than merely forbidden; a
check makes `canonical` without a ratifier unrepresentable. See
`docs/04-data-model.md` for why each mechanism is the one chosen.

**Auth.** `auth.resolve_api_key(text)` — SQL, `STABLE`, `SECURITY DEFINER`,
`search_path` pinned, owned by a dedicated `standfast_auth` role that holds exactly
one narrow `SELECT` policy on `api_keys`. Revocation and expiry live in that
policy, so an expired key is invisible to the lookup rather than filtered by
application code someone could later reorder. Keys are 256 bits from a CSPRNG,
stored only as a SHA-256 digest.

**API.** Hono with `@hono/zod-openapi`. Projects: list, create, get, patch,
delete. Documents: list, put-by-path, get, delete, plus list-sections and
read-one-section — a section is what an atom cites, so it has to be readable
on its own. Atoms: list, create, get, ratify. The create schema has no
`status` field; ratify returns 403 for an agent actor, and the database
refuses independently if that check is ever bypassed.

**Generated artifacts.** `infra/openapi/openapi.json` is committed. The SDK
types are generated from that file, never from a running server. CI
regenerates both and fails on a diff.

**CLI.** `standfast login | logout | whoami | project ls | project create |
doc ls | doc push | atom ls | export`. One dependency — the SDK — with
argument parsing from `node:util`. `export` writes full Markdown to a
directory the customer controls and refuses any server-supplied path that
escapes it (`docs/02-principles.md`, 11).

**MCP.** The `standfast` server over stdio with `read`, `propose` and `status`.
`context`, `search` and `reconcile` are specified in `docs/08-mcp-server.md`
and deliberately **not stubbed**: an agent that calls a tool returning nothing
learns not to call it again, and that lesson outlives the stub.

### What phase 0 did not deliver

`packages/worker` declared `pg-boss` and exported nothing. There was no queue,
no embedding column, no extraction, no retrieval, no reconciliation, no
pagination, no sync daemon, no hooks, no plugin. `atoms.superseded_by` is a
column with no endpoint that writes it.

Phase 1a has since added the embedding column and the extraction tables; the
rest of that list is still outstanding.

### Exit criterion (met)

CI is green on: Biome, `tsc -b`, `vitest run --coverage`, the OpenAPI drift
check, the SDK drift check, "every forward migration has a reverse", an
up/down/up round-trip against Postgres 16 with pgvector, and the integration
suite run as a non-superuser holding `standfast_app`. Within that suite, three
tests are the ones that matter, because each attempts a violation and watches
it fail:

- an unset GUC returns zero rows **on a connection that has already served
  another transaction** — the only state in which the empty-string case
  appears;
- every table reports `relforcerowsecurity`;
- an agent actor cannot ratify, and the wire allowlist matches
  `information_schema.columns` exactly.

## Phase 1 — extraction

Design document: `docs/05-extraction.md`.

**Scope.** A pg-boss queue in the same Postgres, enqueued inside the
transaction that writes the document — transactional enqueue is mandatory, and
a job that survives a rolled-back write is a job that extracts from a document
that does not exist. Section-hash diffing so a document edit re-extracts only
the sections whose hash moved. Model-driven extraction of candidate atoms,
strictly on the write path. Verbatim quote verification, which is what
`packages/core/src/markdown.ts` already counts offsets in Unicode code points
for. Atom embeddings and deduplication at the settled bands — cosine < 0.80
distinct, > 0.93 merge, an LLM judge only in between. An extraction-state
table recording which section hash was extracted by which model version, so
"when models improve, everything regenerates" is a query rather than an
archaeological dig.

Embeddings land here rather than in phase 2 because deduplication needs a
similarity signal and deduplication is part of extraction. Phase 2 adds the
HNSW index and the read path that uses it; phase 1 only writes vectors.

**Done.** Pushing a Markdown document produces provisional atoms, each
carrying a quote that verifiably appears in the section it names.

**Sub-phases.** Phase 1 is the first phase large enough to need them, and the
split is not arbitrary: it puts everything that can be built and tested without
a model provider before anything that cannot. `eval/src/preconditions.ts` and
`packages/api/src/routes.ts` already name these, and cite this document for
them.

| | Scope | Needs a model |
| --- | --- | --- |
| **1a** | the schema invariants: composite key, quote trigger, embedding column, `section_extractions`, `atom_suppressions` | no |
| **1b** | the evaluation harness: corpus, label format, scoring, `pnpm eval check` | no |
| **1c** | the queue, the worker, and the pipeline behind injected ports with deterministic fakes | no |
| **1d** | binding the real extractor, embedder and judge — and the outbound allowlist that governs them | yes |

1a, 1b and 1c have shipped; criteria 1 to 3 below are asserted in
`packages/worker/src/exit-criteria.integration.test.ts`. Sub-phases are a
decomposition of phase 1, not a renumbering of it: the contract above still
holds.

**The outbound allowlist belongs to 1d, not to phase 2.**
`docs/13-threat-model.md` schedules it before phase 2 on the grounds that phase
2 is the first to send a developer's live query off the machine. That argument
is about the payload; the rule is about the destination, and 1d opens this
repository's first outbound socket. Retrofitting a start-up refusal onto a
shipped worker is a breaking configuration change for every deployment that
already worked.

**Exit criterion.**

1. A query over the whole database returns zero atoms whose `source_quote` is
   not equal to `substring(section.body …)` at `source_span`. This is a gate,
   not a measurement — anti-hallucination by verbatim verification means the
   number is zero or the phase is not done.
2. Re-running extraction over an unchanged project enqueues zero jobs.
3. Deleting every atom in a project and re-running rebuilds them from the
   documents alone, with no manual input (`docs/02-principles.md`, 7). The
   extraction rows go with the atoms: `section_extractions` is what makes a
   re-run a no-op, so a test that clears only `atoms` re-enqueues jobs that all
   find their section already `succeeded`, write nothing, and compare equal
   because nothing ran. Stated here because the criterion is otherwise
   satisfiable by a tautology.
4. Extraction precision is measured on a labelled corpus and recorded. The bar
   is not yet chosen — see *Open*.
5. The outbound allowlist exists and refuses at start-up
   (`docs/13-threat-model.md`, *Egress*, rule 1): the extraction model, the
   embedding provider and the dedup judge are each a configured entry with a
   pinned version, and a destination not on the list is not called. 1d opens
   the first outbound socket in this repository; the control has to land before
   the traffic does, not after. **Built in 1c** — one phase ahead of the
   adapters — in `packages/core/src/egress.ts`. What 1d owed it — the
   `assertEgressAllowed` call beside each adapter, and the per-project record
   of what actually left that rule 3 asks for — is paid: `admitEgress` in every
   adapter constructor, the `egress_events` table the handler writes before each
   call, and `GET /v1/projects/{projectId}/egress` — `standfast egress` — so that
   answering rule 3 needs neither a source file nor a SQL prompt.

Criterion 4 is what makes phase 1 subject to the harness rule below: the
labelled corpus exists **before** the first prompt or threshold is tuned, not
after the first disappointing result.

## Phase 2 — retrieval

Design document: `docs/06-retrieval.md`.

**Scope.** HNSW at 1024 dimensions, `tsvector` and `pg_trgm` indexes. Four
candidate generators, RRF fusion at k=60, a cross-encoder reranker, assembly
under an explicit token budget with MMR at λ≈0.7 — all settled in
`docs/00-handoff.md`, all to be recalibrated on a real corpus. The `context`
and `search` MCP tools with the response envelope from
`docs/08-mcp-server.md`, including a `truncated` flag that is set by the
generator and never inferred from `returned < total`. The Claude Code
`SessionStart` and `UserPromptSubmit` hooks, because MCP is pull and cold
start needs push.

`docs/13-threat-model.md` must be settled before this ships. Phase 2 is the
first time an atom is injected into a session that did not ask for it, which
is the moment principle 13 — knowledge is an instruction channel — stops being
theoretical.

**Done.** An agent that names a file or a task gets the atoms that govern it,
inside the budget it asked for, without having asked for anything else.

**Exit criterion.**

Criteria 1, 2 and 6 are asserted today. Criteria 3, 4, 5 and 7 are not, and
each names what it is waiting for.

1. For every query in the corpus, the assembled pack is at or under
   `budget_tokens`. The assembler respects the budget; it does not approximate
   it. A gate, not a measurement. **Asserted** in
   `packages/core/src/pack.test.ts`, swept across a range of budgets rather
   than checked at one convenient number — with the one honest exception the
   assembler documents: a budget below the empty envelope's own cost cannot be
   met by any response, and the pack reports what it actually sent rather than
   a zero that would be a lie.
2. `truncated` is asserted by test to come from the generator, on a case where
   `returned == total` but results were dropped upstream. **Asserted** twice:
   in `packages/core/src/pack.test.ts` for the assembly boundary, and in
   `packages/db/src/testing/retrieval.integration.test.ts` against a real
   generator cap.
3. A declared p95 latency for `context`, written into the repository as a
   number and enforced by a test. The value is not yet chosen — see *Open*.
4. Retrieval precision under a fixed token budget, measured on a labelled
   query set. The bar is not yet chosen — see *Open*.
5. The thresholds in use are the recalibrated ones, and the corpus they were
   calibrated on is committed. Shipping the defaults from `docs/00-handoff.md`
   unchanged would mean nobody checked them.
6. The reranking endpoint is on the outbound allowlist phase 1d built, with a
   pinned version. The allowlist itself is a phase-1 criterion — phase 2 adds
   one destination to a control that already refuses at start-up, which is the
   cheap direction. **Satisfied vacuously, and that is worth saying plainly:**
   `reranking` is a purpose the disclosure log can *record* and that
   `PERMITTED_PURPOSES` does not admit — so no provider is bound to it and none
   could be configured. The read path's other model call, `query-embedding`, is
   refused on the same terms. `docs/06-retrieval.md`
   condition 2 wants a model operated by us in the region of the database, and
   that infrastructure does not exist — so the reranker stage is built,
   skippable, and skipped, and every response says so in `skipped`. A criterion
   met by having nothing behind it is met only until something is.
7. A hook assertion. Phase 2 ships the push half of the product
   (`docs/09-agent-contract.md`), and criteria 1–6 all measure the pull half.
   At minimum: a test that a `SessionStart` hook failing does not block the
   session, and a recorded per-session token cost for what it injects.
   Otherwise half the surface ships unchecked while the other half is gated on
   four numbers.

**On generator 1, which still does not run.**

The read path's query embedder exists — `packages/api/src/adapters/query-embedder.ts`,
resolved at start-up by `packages/api/src/ports.ts`, disclosed under its own
egress purpose by migration 0008. What does not exist is permission to use it,
and that is deliberate in two independent ways.

`PERMITTED_PURPOSES` does not admit `query-embedding`, so the allowlist parser
refuses the entry and no deployment can be configured to make the call. That is
rule 2 of `docs/13-threat-model.md`: a task description typed minutes ago and
sent while the developer waits is a different procurement decision from stored
prose sent overnight, and it needs its own consent. Reusing the `embedding`
purpose would have passed every existing check while stretching a permission
granted for the second to cover the first.

And even with that consent, `docs/06-retrieval.md` condition 4 wants a measured
p95 for the call that fits inside `context`'s — a number this document leaves
unchosen and calls unchoosable until a corpus exists. All five conditions are
required together, so the condition furthest from being met is not the privacy
one.

The honest summary: **retrieval runs on three generators, everywhere, today**,
and says `"dense"` in `skipped` rather than implying it searched by meaning.
Turning the fourth on is one line in `PERMITTED_PURPOSES` plus a p95 nobody can
measure yet — and the adapter refuses any destination the operator does not run,
so when that line is added the choice is between our own model and nothing,
never between providers.

   **Asserted** in `packages/mcp/src/hooks.test.ts`, over four failure modes
   rather than one — transport error, API error, a response carrying neither
   data nor error, and a body that is not a pack. They arrive by different
   routes, and only a table of them shows the fail-open path is the *only*
   path. `packages/mcp/src/hook-bin.ts` exits 0 unconditionally, including from
   its own catch.

   The recorded cost is `SESSION_START_BUDGET_TOKENS = 800`, deliberately below
   the `context` tool's own default of 2000: pushed context arrived
   unrequested, so it is conservative by default, and a test pins the
   inequality rather than trusting the comment. Note what this criterion still
   does not measure — whether the injected pack is *useful*. That is criterion
   4's job and criterion 4 is waiting on the corpus, so a hook that fires
   reliably with a worthless pack passes 7 and fails the product.

### Principle 4, and the distinction it now draws

Principle 4 read *"no model call between an agent's question and its answer"*
until phase 2 forced the question, because a query embedding and a
cross-encoder reranker are both model calls and both sit between the question
and the answer. The owner amended it: **no *generative* model call**, the
pipeline admitting only pinned, bounded embedding and reranking.

The amendment is narrow on purpose. Principle 4 exists because a generative
call on the read path makes latency unbounded, output non-reproducible and
cost per-session. Pinned weights are none of those — same input, same ranking,
and a latency ceiling that can be asserted. The principle's own title is
*determinism*, and that is what the wording now protects.

So the distinction has to be enforced rather than assumed, as a hard
acceptance test on the still-open choice of reranking provider: **determinism
and a bounded, measured p95, or the reranker does not go on the read path.** A
hosted generative endpoint that reranks fails it, and principle 4 still wins.

## Phase 3 — reconciliation

Design document: `docs/07-reconciliation.md`.

This is the moat. `docs/02-principles.md` (1): keeping a record of decisions is
trivial, knowing whether the code still honors them is not.

**Scope.** The `reconcile` MCP tool. A findings table carrying `atom_id`,
`file_path`, `line_start`, `line_end`, `verdict` and an optional short
rationale — a verdict and a pointer, nothing else — with
`packages/db/src/schema/wire-allowlist.ts` extended in the same diff, so the
equality test forces a reviewer to see the new columns. The loop that drives
it: a `PostToolUse` hook after `Edit`/`Write` queues the changed file, the
agent reads the code locally in its own session, and submits verdicts.
Prompts written to falsify (`docs/02-principles.md`, 8): the agent is asked
what would disprove the atom, never what supports it. Drift surfaced through
`status`. Nothing is fixed, deprecated, or opened as a pull request
(`docs/02-principles.md`, 6).

The optional rationale deserves a sentence, because it is the only free-text
field anywhere on the reconciliation path and therefore the only place an
agent could paste source code into a system whose third invariant is that
source never leaves the machine. It is capped in length and validated harder
than anything else in the schema. Whether a length cap is sufficient is *Open*
— but the field is recognised as the hole, and the alternative of removing it
entirely stays on the table.

**Done.** An edit that violates a canonical atom produces a finding naming the
atom and the lines. An edit that does not, produces nothing.

**Exit criterion.**

Criterion 2 is asserted. Criteria 1 and 3 are not, and both wait on the same
thing: a corpus that does not exist and labels no model may write.

1. **Reconciliation false-positive rate below 5% on the labelled corpus.**
   This is the kill metric; see below. **Not met, and not measured.**
   `pnpm eval reconciliation` exists and always reports `SKIPPED` with its
   reason, and `reconciliation_false_positive_rate` keeps `baseline: null` in
   `eval/baselines.json`. The bar is the one number this document already owns —
   5%, and a hard threshold — so the first figure it ever prints is one the
   product can be killed by, and a figure produced without a human labeller
   would measure how hard somebody tried.
2. No field of `reconcile` accepts source code — asserted by a schema test,
   and by the wire allowlist equality test over the findings table.
   **Asserted** in three places rather than one, because the claim is about a
   boundary and a boundary has sides: `packages/api/src/reconcile-schema.test.ts`
   pins the accepted field set by equality and sweeps sixteen names somebody
   would reach for to smuggle a snippet, every one refused by `.strict()` rather
   than silently dropped; `packages/db/src/testing/schema-guards.integration.test.ts`
   compares the wire allowlist against `information_schema` for both new tables;
   and `packages/api/src/mcp.integration.test.ts` calls the tool itself with an
   extra field and watches it fail *with a message naming the field*, because an
   earlier version of that test passed for a reason unrelated to the guard and
   would have gone on passing after the guard was removed. The response schema
   is asserted not to carry the rationale back out, which is the other direction
   of the same invariant — and `filePath`, which is the field that *is* served
   back, carries the same character rule as the rationale, so a path cannot
   become the free-text field the rationale is not allowed to be.
3. The corpus and the labelling procedure are committed, so the 5% can be
   recomputed by someone who did not run it the first time. **Not met.** Two
   questions have to be answered before the number means anything and neither
   is a coding task: the minimum finding count below which the rate is not
   reportable, and whether the corpus is labelled per model or the criterion
   names a reference model — the check runs in the customer's session, so the
   rate is model-dependent and a figure measured on one model does not transfer.

**What shipped without its number.** The loop is built: the sixth and last MCP
tool, the two tables with the falsification constraint and the queue
biconditional in the schema, the `PostToolUse` hook, drift through `status`, and
the human's two commands. None of that is evidence that it works. A reconciler
that fires reliably and is wrong 20% of the time passes every test in this
repository and fails the product, which is exactly what criterion 1 is for.

## Phase 4 — distribution and the ratification loop

Design documents: `docs/10-sync-daemon.md` and `docs/11-git-export.md`.

Phase 4 exists because the product has a bottleneck and it is a human reading
provisional atoms. `docs/02-principles.md` (5) makes the throughput of that
review a first-class product metric rather than an interface detail, and
nothing in phases 1 to 3 moves it by a single atom. Bundling that with
distribution is not a filing convenience: both are about the moment someone
who did not build this uses it.

**Scope.** The sync daemon watching the customer's folder, which becomes the
*default* write path for documents and demotes `standfast doc push` to a
convenience. It does not become the only one: the HTTP endpoint stays open to
any credential in the org, and `docs/10-sync-daemon.md` designs for that rather
than pretending otherwise — a daemon that assumed exclusivity would corrupt
data the first time someone used the CLI it ships alongside. Git export to a
repository the customer controls, beyond
the one-shot directory dump the CLI does today. The ratification surface, which
is the CLI: the queue a human works through, with provenance shown and
imperative or meta-instruction patterns flagged (`docs/02-principles.md`, 13). Packaging as
a Claude Code plugin bundling the MCP server and the hooks, and as a plain MCP
server everywhere else. Publication to the MCP registries. A release supply
chain that is pinned, signed and attested, with nothing resolving "latest" at
startup.

Registry publication waits until here on purpose. A server that serves almost
nothing spends a first impression that cannot be spent twice.

**Done.** Someone who has never seen this repository installs it, points it at
a folder, and gets a context pack in their first session — and the provisional
queue does not grow without bound.

**Exit criterion.**

None of the three is met. Criterion 2's *machinery* exists, which is not the
same thing and is worth keeping apart.

1. A scripted end-to-end from a clean machine, run in CI: install, sync a
   folder, open a session, receive a context pack, ratify an atom. **Not met.**
   Four of the five steps are reachable: `standfast queue`, `next`, `ratify`,
   `reject`, `retire` and `ratification` exist, and a session already receives a
   context pack. Syncing a folder has nothing at all, because the daemon does not
   exist — and nothing runs the sequence end to end from a clean machine, which
   is the part the criterion is actually about.
2. Ratification throughput computed from `atom_events` — median time from
   `proposed` to a decision, and the share of provisional atoms older than a
   chosen age. The table has existed since migration `0000` precisely so this
   is not a metric that had to be started from zero. The bar is not yet
   chosen — see *Open*.

   **Computable, and uncomputed.** `ratificationThroughput` in
   `packages/db/src/repositories/ratification.ts` returns the median — a real
   `percentile_cont(0.5)`, because one atom that sat for three months drags a
   mean and says nothing about the typical review — and `null` rather than zero
   when nothing has been decided, since zero would read as instant review. The
   age threshold is a **required argument with no default**, at the repository,
   the route and the CLI alike: the bar is unchosen, and a default anywhere on
   that path would quietly become it. What is missing is a human choosing the
   number, not code.
3. A release job that fails on an unsigned or unattested artifact. **Not met.**

**And the rejection reason is why criterion 2 could be honest at all.** Phase 4
added a reject route because clearance counted half a reviewer's work without
one: a queue drains by two decisions and only one was routed, so a throughput
metric built before it would have measured half the job and looked fine doing
it.

## Phase 5 — teams

**Scope.** Memberships and roles, a shared ratification queue, per-project
permissions, an audit view over `atom_events`.

This is additive rather than structural, and that was bought in phase 0:
`org_id` is on every row from the first migration and a solo user is an org
with one member, so teams means adding rows to `actors` and one membership
table, not re-keying eight tables and rewriting every policy against live
customer data.

**Done.** A second human in the same org sees the same knowledge and can
ratify it.

**Exit criterion.**

1. The RLS suite extended with a second member and a second org; the
   cross-org attempt still returns zero rows.
2. Every new table appears in the wire allowlist, deliberately, in a diff a
   reviewer saw.
3. None of the four numbers regresses on the committed corpora. This is
   checkable only because the harness has existed since phase 1.

## Ordering constraints

Each of these is a blocking dependency, not a preference.

**0 → 1.** Extraction writes atoms that cite sections. Both existed before the
first extraction job did, which is why phase 1 adds a queue rather than a
schema.

**1 → 2.** There is nothing to retrieve. Building ranking against a corpus of
hand-written atoms would tune the ranker on a distribution that will never
occur again once real extraction replaces it.

**2 → 3.** Reconciliation has to select which atoms govern a changed file, and
that selection *is* retrieval. Shipping phase 3 on a keyword match would
measure the false-positive rate of a system we are about to replace — and the
kill metric can only be measured honestly once, because the second measurement
is taken by someone who already knows what answer they want.

**3 → 4.** Publication and packaging spend a first impression. See phase 4.

**4 → 5.** Teams multiply ratification. If the single-human loop is slow,
adding humans to it makes the queue worse, not better — more proposers, same
review capacity, and now a diffusion-of-responsibility problem on top.

**Every phase → its own harness.** Below.

## Why the harness comes before the tuning

`docs/02-principles.md` (10): *"The evaluation harness precedes
optimization."* The anti-pattern list is blunter: *do not tune a threshold
without a labelled corpus.*

The settled numbers in `docs/00-handoff.md` — 0.80 and 0.93 for
deduplication, k=60 for fusion, λ≈0.7 for assembly — are starting points taken
from the literature, and `docs/00-handoff.md` already says they are to be
recalibrated on a real corpus. Recalibration without a labelled corpus is not
recalibration. It is fitting the system to the last example somebody looked
at, and it feels like progress the entire time it is happening.

So the harness is not a phase. It is a precondition **inside** each phase,
between the "make it work" half and the "make it good" half:

| Phase | Corpus that must exist first | Before tuning |
| --- | --- | --- |
| 1 | labelled sections with expected atoms | extraction prompts, dedup bands |
| 2 | labelled queries with expected atoms | generator weights, k, λ, reranking |
| 3 | labelled edits with expected verdicts | verdict prompts, drift heuristics |
| 4 | recorded `atom_events` from real use | queue ordering, batching |

A phase does not exit on a number it cannot reproduce. That is the whole rule.

## The kill metric

**Reconciliation false-positive rate above 5% means users switch the feature
off and never switch it back on.** Phase 3 owns it.

It is a kill metric and not a quality metric, and the difference is what
happens at 6%: phase 3 does not ship at 6% with a plan to improve. It does not
ship. There is no version of this where a user turns a noisy checker back on
after they have already decided it cries wolf, because the cost of re-enabling
it is paid immediately and the benefit is speculative.

Two consequences that are easy to miss:

- **The error budget is asymmetric.** A false negative costs what today
  already costs — silent drift, which is the status quo the user arrived with.
  A false positive costs trust, once, permanently. So every tuning decision
  breaks towards silence. A reconciler that says nothing is useless; a
  reconciler that cries wolf is worse than useless, because it also
  discredits the atoms it was citing.
- **It is measured before launch, then monitored after.** Phase 3 measures it
  on a labelled corpus. From phase 4 it is a production number, and a
  regression above the threshold is an incident, not a backlog item.

`docs/00-handoff.md` still lists the exit threshold as *proposed*. Recorded
here as the exit criterion at < 5%, with one direction of travel available:
the bar can tighten on evidence, and cannot loosen, because loosening it
contradicts `docs/02-principles.md` (10) rather than merely disappointing it.

## Documents this roadmap owes

`docs/00-handoff.md` holds that a design document comes before the code it
governs. This is the schedule that implies.

| Document | Settled before |
| --- | --- |
| `docs/03-architecture.md` | phase 1c — the worker stops being an empty package, and its "separate process or a mode of the API" question closes |
| `docs/05-extraction.md` | phase 1 |
| `docs/12-evaluation.md` | the tuning half of phase 1 |
| `docs/06-retrieval.md` | phase 2 |
| `docs/09-agent-contract.md` | phase 2 — the first unprompted injection |
| `docs/13-threat-model.md` | phase 2 |
| `docs/07-reconciliation.md` | phase 3 |
| `docs/10-sync-daemon.md` | phase 4 |
| `docs/11-git-export.md` | phase 4 |
| `docs/15-ratification.md` | phase 4 |

Three phase-4 deliverables deliberately get no design document: Claude Code
plugin packaging, publication to the MCP registries, and the pinned, signed,
attested release job. They are specified in CI configuration and in
`packages/*/package.json`, and a prose document describing a workflow file
would go stale the first time the workflow changed. The release job stays an
exit criterion; `docs/13-threat-model.md` holds the properties it must have.


Every one of those now exists. The last was the gap worth naming, so
what it settled is worth recording here rather than only there: FIFO ordering
with a section tie-break and no weighting; the reading order that puts the
quote before the statement; the reject route and the structured optional
reason; supersede as a field on ratify rather than a fifth route; the
surfacing contract for a flagging heuristic that does not exist yet; and the
argument that throughput may only be bought by producing fewer items or by
making each cheaper without removing what is read.

It also surfaced one thing the data model cannot express, carried below as an
open decision.

## Deliberately not on the roadmap

Recorded so each question is asked once.

- **A web editor or documentation site.** The customer's folder is the working
  surface (`docs/01-thesis.md`). The phase 4 ratification queue is a review
  surface, not an editor: it decides the status of atoms, and never edits the
  documents they project from.
- **Any representation of source code** — contents, AST, call graph, file
  tree. Not deferred; excluded. It would end invariant 3 in one commit.
- **Auto-fix, auto-deprecate, auto-PR.** Recommender, never actor
  (`docs/02-principles.md`, 6). This will be requested, because a finding that
  names the line looks one small step from a patch. The step is the product.
- **Agent self-ratification in any disguise** — confidence scores that
  auto-promote, "trusted agent" flags, auto-canonical after N agreements. The
  database says no, and the schema is the argument.
- **An eleventh MCP tool, or filling the four unspent slots.** The cap is a
  budget (`docs/02-principles.md`, 3). Spending it is not an achievement.
- **A hosted memory or retrieval SDK in any workspace package.** Would break
  the third invariant on the way past.
- **Training or fine-tuning an extraction model.** Re-derivability means we
  regenerate when models improve; owning a model means we are the reason they
  do not.
- **Non-Markdown ingestion** — Notion, Confluence, Google Docs. Genuinely
  attractive and genuinely deferred: each connector multiplies the sync
  surface, and none of them make reconciliation more accurate. Revisit after
  phase 4, on demand, not on enthusiasm.
- **Multi-repository knowledge graphs, IDE extensions beyond MCP, real-time
  collaboration.** Each is a different product wearing this one's clothes.
- **The hosted offering as a phase.** The licence split already anticipates it
  (`docs/00-handoff.md`), and hosting differentiates on operations and bundled
  model spend, not on code. It is an operations track that can start whenever
  it is worth staffing; it does not gate or get gated by any phase here.

## Open

Each item below names the phase it must close by. An open question with no
deadline is a question nobody answers.

- **The bars.** Only the kill metric has a number — < 5%, settled here and in
  `docs/00-handoff.md`. Extraction precision, retrieval precision under budget,
  and ratification throughput have no threshold, and inventing one before the
  corpus exists would be the exact failure principle 10 describes. *Each closes
  with the phase it gates.*
- ~~**The embedding provider**~~ — **closed: voyage-3.** Native 1024, so the
  column that shipped in `0002` needs no truncation and no Matryoshka
  assumption, and its 32,000-token input limit is the loosest of the candidates
  considered, which leaves the section window free to be chosen on extraction
  grounds rather than on the embedder's ceiling. OpenAI's `text-embedding-3-large`
  reaches 1024 only by truncating, and its 8,191-token limit would have been the
  binding constraint on the window.

  **What this decision does not buy, stated plainly:** voyage-3 is hosted only,
  so a deployment that runs its own models cannot use this adapter, and
  `docs/13-threat-model.md`'s Egress rule 4 — every outbound call points at
  something the operator could run themselves — is aspirational until a second
  adapter exists. `bge-m3` is the candidate that closes it: natively 1024, so it
  fits the same column, and weaker on public benchmarks in ways nobody has
  measured against the only thing phase 1 uses embeddings for, which is
  deduplication. **This roadmap keeps that as an open item**, below, rather than
  letting the provider decision quietly settle it.
- **A self-hostable embedding adapter — half closed.** The column is 1024 and
  `bge-m3` fits it, so this was an adapter and a benchmark rather than a
  migration. **The adapter has shipped**:
  `packages/worker/src/adapters/bge.ts`, over an OpenAI-compatible endpoint an
  operator runs themselves, selected by `STANDFAST_EMBEDDING_PROVIDER` rather than
  by the model name — a port's id is identity and never dispatch.

  **The benchmark has not**, and until it does this item stays open. The
  measurement it needs — does the published quality gap matter for the only
  thing phase 1 uses embeddings for, which is deduplication? — is the same
  corpus of human-labelled same-claim pairs that the 0.80/0.93 bands need, and
  that corpus does not exist. Shipping the adapter makes Egress rule 4
  *reachable*; a deployment that switched to it on the strength of the code
  existing would be tuning on nothing, which is what
  `docs/02-principles.md` (10) forbids. **This roadmap still owns it, closing
  before phase 2**, which is where a self-hosted deployment first has a read
  path to protect.

  One consequence worth stating before someone meets it: `bge-m3`'s window is
  materially smaller than voyage-3's, so the adapter declares a smaller
  `maxInputChars` and therefore becomes the binding constraint on how a long
  section is split. Choosing the self-hosted embedder changes extraction, not
  only egress.
- ~~**Pagination on list endpoints.**~~ **Closed.** Every list endpoint takes
  `limit` and `offset` and returns `{ items, total, returned, truncated }`.
  `total` is a window function in the same statement that applied the limit, so
  `truncated` is decided where the whole set is visible rather than inferred at
  a boundary that has already lost it.

  `STATUS_SCAN_LIMIT` is gone, and it was worse than the cap in the wrong layer
  this list called it: `status` fetched every atom in a project to produce four
  numbers, and past five hundred those numbers counted an arbitrary prefix — a
  large project under-reported its own ratification queue, which principle 5
  calls a first-class product metric. It is now an aggregate,
  `GET /v1/projects/{projectId}/atoms/stats`, exact at any size and with no
  truncation to report.

  Two consequences worth naming. Every paginated query orders by something
  total, because offset paging over a non-total order returns rows twice and
  misses others while erroring on nothing — pinned by a test that walks a list
  page by page and demands each row exactly once. And `standfast export` walks
  every page rather than taking the first, since principle 11 makes full export
  the anti-lock-in guarantee and a silently partial export is a guarantee that
  quietly is not one.
- **The p95 latency contract for `context`.** Principle 4 says latency is a
  contract; the value of that contract is unchosen. Four documents defer to
  each other on it — `docs/03-architecture.md`, `docs/06-retrieval.md`,
  `docs/09-agent-contract.md` and this one — so **this roadmap owns it,
  closing before phase 2 ships**. It cannot be measured first and declared
  after: a contract set to whatever the implementation happened to achieve is
  not a contract.
- **Whether the cross-encoder stays on the read path**, which depends on the
  reranking provider — itself open in `docs/00-handoff.md`. See the acceptance
  test in phase 2.
- **Whether a length cap is sufficient protection for the `reconcile`
  rationale field**, or whether free text has no place on that path at all.
- **Whether the sync daemon should arrive before phase 4.** It is the intended
  write path for documents (`docs/08-mcp-server.md`) and `doc push` is the
  stand-in. Nothing blocks on it, which is the only reason it is where it is.
- **Whether phase 4 should split** into distribution and the ratification
  loop. It would be honest about their different natures; it would also
  renumber phase 5, which the first paragraph of this document forbids. So the
  split, if it happens, is 4a and 4b.

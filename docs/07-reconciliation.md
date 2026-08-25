<!-- docs/07-reconciliation.md -->
# Reconciliation

> **Status: built, and unmeasured.** Phase 3 shipped the loop described here.
> Migration `0009` creates `reconciliation_runs` and `reconciliation_findings`,
> and both are named in `packages/db/src/schema/wire-allowlist.ts`. `reconcile`
> is an MCP tool — the sixth and last `docs/08-mcp-server.md` names — a
> `PostToolUse` hook fires after every `Edit` and `Write`, drift counts come
> back through `status`, and `standfast findings ls` and `findings resolve`
> put the reading and the resolving in front of a human, which is the only
> actor either one accepts.
> **No exit criterion is claimed.** `reconciliation_false_positive_rate` is the
> kill metric and its `baseline` is `null` in `eval/baselines.json`, so
> `pnpm eval reconciliation` reports SKIPPED and will keep reporting it until a
> human labels a corpus. Built is not measured, and the 5% bar has never been
> tested against anything. Everything still genuinely undecided is under
> *Open*, including whether the rationale field should hold free text at all
> (`docs/13-threat-model.md`).

## Why this is the moat

`docs/02-principles.md` (1): keeping a record of decisions is trivial, knowing
whether the code still honors them is not. `docs/01-thesis.md` says the same
thing from the other end — cold start and tool divergence are retrieval
problems, and retrieval is table stakes; silent drift is a verification
problem, and it is the only one that justifies a product.

So this is the document where the product either exists or does not. It is
also the document with the highest chance of destroying the product, because a
verifier that is wrong one time in twenty is switched off and never switched
back on. Most of what follows is spent buying accuracy with silence.

## The shape of the loop, and why it is a pull loop

The constraint that determines everything: **Standfast cannot perform a check.**
It holds no contents, no AST, no call graph and no file tree
(`docs/01-thesis.md`), and it has no reach into the customer's machine. The
reading happens in the customer's own agent session, on their side of the
trust boundary in `docs/03-architecture.md`.

The server therefore has exactly two moves: it can say *which atoms govern
this path*, and it can record *what came back*. It can mark work as due. It
can never make the work happen.

That is a pull loop with a work list, drained by whatever agent session
happens next. Stating it plainly kills a whole class of design that would
otherwise look reasonable — a nightly scan, a scheduled sweep, a "check the
repository now" button. Each of those promises execution the server cannot
perform. A schedule that cannot fire is a schedule that lies.

One consequence worth holding onto: **the expensive half of reconciliation is
paid by the customer's agent, in their session, with their tokens.** Standfast's
side of a check is a select and an insert. That is how phase 3 can be the
moat without straining `docs/02-principles.md` (4): the model that judges the
code is not on our side of the wire at all. What runs here is atom selection,
which `docs/06-retrieval.md` governs and which admits two pinned, bounded
calls and nothing generative.

The other consequence is that session tokens are a budget with the same
failure mode as the false-positive rate. A hook that fires after every edit
and spends three thousand tokens each time gets disabled, and the user who
disables it is the one who needed it. Cost and noise kill the feature by the
same mechanism.

## Which atoms are checked

**Only canonical atoms.** Nothing provisional, ever.

Two independent reasons, and either alone is sufficient.

A provisional atom is an agent's unreviewed guess (`docs/01-thesis.md`,
invariant 2). Checking code against it means an unreviewed guess generates a
finding, and a finding is a directive pointed at a human — principle 13 says
knowledge is an instruction channel, and this would be the widest possible
one, opened before ratification rather than after it.

The second reason is worse. If a provisional atom could be checked and
"confirmed", agreement with code becomes evidence for promotion, and evidence
for promotion is the beginning of auto-promotion. `docs/14-roadmap.md`
excludes agent self-ratification *in any disguise*, naming confidence scores
and "auto-canonical after N agreements" specifically. A checker that runs on
provisional atoms is that disguise with a different job title.

`rejected` and `superseded` atoms are not checked either, for the obvious
reason. The selector is `status = 'canonical'` and it is not a parameter.

### Selecting which canonical atoms govern a change

That selection *is* retrieval, which is why `docs/14-roadmap.md` makes 2 → 3 a
blocking dependency rather than a preference. Reconciliation calls the same
path `context` uses: candidate generators, fusion, assembly under a budget, no
generative model call (`docs/06-retrieval.md` owns it, and states the two
pinned model calls the pipeline does admit and the conditions on them).

The atom set per check is capped, and the cap is low. A check that asks an
agent about twenty atoms at once returns twenty shallow answers; a check that
asks about three returns three considered ones. The number is unknown and
belongs to the phase 3 corpus — see *Open*.

## Triggers

| Trigger | Fires where | Selects | Why it exists |
| --- | --- | --- | --- |
| `post_edit` | Claude Code `PostToolUse` after `Edit`/`Write` | the paths just written | the only moment the change is fresh *and* the agent still holds the intent behind it |
| `session_end` | Claude Code `Stop` | paths accumulated during the session, deduplicated | one check per file per session, not one per keystroke |
| `explicit` | `standfast check [paths]` | what the human names | the escape hatch, and how a CI job would do it |
| `agent` | any MCP client calling `reconcile` unprompted | whatever the agent decided | hooks are one client; MCP is the promise (`docs/08-mcp-server.md`) |
| `atom_ratified` | server marks due, an agent session drains it | files previously checked against neighbouring atoms | the knowledge changed, not the code — nothing has ever checked the new atom against anything |
| `stale` | server marks due | `(atom, file)` pairs not checked for longer than a threshold | drift is slow; a loop that only fires on edits never notices the file nobody edits |

`post_edit` is the trigger everyone thinks of first and it is not the most
important one. `atom_ratified` is: the moment a human promotes an atom is the
moment a rule starts applying retroactively to code written before it existed,
and no edit will occur to prompt a check.

`stale` is measured in **time since the last check, not in file change**,
because the server does not know when a file changed and will not be told —
knowing that would require either a file tree or a content hash, and a hash of
source is source (see *What crosses the wire*). This is a real weakness:
staleness will re-ask questions about files that did not move. The mitigation
is suppression, below, not a hash.

Two of the six triggers are hooks, and hooks exist on one client. For Cursor,
Codex and Gemini the loop is `explicit`, `agent`, `atom_ratified` and `stale`.
That asymmetry is already stated in `docs/08-mcp-server.md` and is not
repaired here: the deterministic half is one client's, the pull half is
everyone's.

Hooks inject and queue. **Hooks never block.** There is no `PreToolUse`
gate — `docs/01-thesis.md` says the context pack informs the work and never
gates it, and a blocking checker running at a 5% false-positive rate would
block correct work one time in twenty, which is a worse product than no
checker at all.

## What crosses the wire

The tool shape is settled in `docs/08-mcp-server.md` and is restated here only
as a field table, because this is the document that has to defend it.

| Field | Type | Required | Note |
| --- | --- | --- | --- |
| `atom_id` | uuid | yes | must be canonical, in the caller's org |
| `verdict` | enum | yes | four values, below |
| `file_path` | string | yes | relative to the project root, as the client declares it |
| `line_start` | int | on `violated` | 1-based |
| `line_end` | int | on `violated` | ≥ `line_start` |
| `rationale` | string | no | capped, and the one hole in this design |

**No field accepts code.** Not truncated, not hashed, not "just a snippet".
The hash case deserves its own sentence because it is the one that sounds
harmless: a content hash of a source file would make `stale` precise, would
make deduplication exact, and would be a fingerprint of the customer's source
sitting in our database. `docs/08-mcp-server.md` already forbids it in those
words. It follows that the idempotency key for a run may not be derived from
file content either — it comes from the session and the path, never from what
the path contains.

`file_path` is opaque to the server. There is no file tree to validate it
against, and there will not be one. It is stored as a string, normalised by
the client, with a database check as a backstop against the two forms that are
obviously wrong (absolute, or containing a `..` segment) rather than as
validation.

### The rationale field

It is the only free text anywhere on this path, which makes it the only place
an agent could paste source into a system whose third invariant is that source
never leaves the machine. `docs/14-roadmap.md` already recognises it as the
hole and leaves the answer open. Two decisions are taken here, and neither is
a claim that the hole is closed:

- It is **capped hard** — a short sentence, not a paragraph. A cap is a
  mitigation and not enforcement: one line of code fits in any cap that leaves
  the field useful. This is stated rather than papered over.
- It is **never returned to another agent.** It is written once, read by a
  human in the review surface, and served by no MCP tool. It is not indexed,
  not embedded and not searchable. This does not stop the write; it stops the
  field becoming an instruction channel into a later session
  (`docs/02-principles.md`, 13), which is the larger of the two risks.

Removing the field entirely stays on the table. See *Open*.

## The verdict vocabulary

Four values. Each says what a human should do with it, because a verdict that
does not imply an action is a verdict that trains people to skim.

| Verdict | Means | The human's move |
| --- | --- | --- |
| `violated` | a concrete counter-example was found: these lines contradict this atom | fix the code, or supersede the atom — both are human moves |
| `honored` | a counter-example was looked for in the region examined and none was found | nothing; it is coverage, not proof |
| `not_applicable` | the atom does not govern this file | nothing to the code; it is a signal that retrieval mis-selected |
| `unverifiable` | the atom cannot be decided by reading code at all | the atom is badly formed; it belongs back in review, not in the checker |

`honored` is deliberately worded as a residual. It is what you record when the
search for disproof came back empty, and it is **not** the affirmative answer
to "does this file follow the rule?". That distinction is the whole of the
next section, and it is why the word in the interface is never "passed" or a
green tick: a tick claims proof, and nothing here proves anything.

`not_applicable` is not a failure of the checker, it is telemetry for
retrieval. If a project's `not_applicable` share is high, phase 2 is
mis-selecting and phase 3 is paying for it in session tokens. That is a
useful number and it costs one enum value to have.

`unverifiable` exists because the alternative is worse. An atom like *"prefer
clarity over cleverness"* is a real thing a document says and is not decidable
by reading a file. Without this verdict an agent will resolve it to `honored`
or `violated`, and both are lies. With it, the atom surfaces as a knowledge
problem rather than as noise in the code queue.

### Considered and declined in the vocabulary

- **A severity field.** Severity is a property of the atom, not of the
  finding: a violated `constraint` is louder than a violated `convention`, and
  `atoms.kind` already carries that. Adding severity to the finding would let
  an agent grade the volume of its own alarm.
- **A confidence score.** It reads as harmless and it is the auto-promotion
  vector `docs/14-roadmap.md` excludes by name. It also invites a threshold,
  and a threshold on a self-reported number is a self-ratification with
  arithmetic in front of it.
- **`partially_honored`.** Every use of it is either a violation with hedging
  or an atom that says two things and should be two atoms. The pressure it
  relieves belongs on extraction, not here.
- **A free-form verdict string.** Four values is a vocabulary; a string is a
  place for an agent to put a paragraph, and there is already exactly one such
  place too many.

## Falsify, don't confirm — operationally

`docs/02-principles.md` (8): for any verification, ask what would disprove the
claim, never what would support it. Four concrete consequences.

**The prompt asks for a counter-example, not for an assessment.** *"This
project has decided X. Find the lines in this file that make X false. Quote
the line numbers."* Not *"does this file follow X?"*. The second question is
answerable by agreeable-sounding prose, and a model asked whether something
looks fine will usually say it looks fine. The first question has an artefact
as its answer or it has no answer.

**The evidence requirement is asymmetric, and it is a database constraint.** A
`violated` verdict without `line_start` and `line_end` is not merely rejected
by validation — it is unrepresentable:

```sql
check (verdict <> 'violated'
       or (line_start is not null and line_end is not null))
```

This is principle 8 in the schema rather than in a prompt, which matters
because prompts are edited by whoever is iterating on accuracy that week. A
violation must point at its own disproof. A non-violation must point at
nothing.

**The order of the two questions is fixed.** The agent is asked for the
counter-example first and only records `honored` after that search returns
empty. Reversing the order — establish the conclusion, then look for
exceptions — produces confirmation with extra steps, and it produces it
reliably.

**The corpus is built to punish confirmation.** `docs/14-roadmap.md` requires
labelled edits with expected verdicts before any prompt is tuned. Two
properties of that corpus follow from this section and are easy to omit:

- it must contain **near-misses** — edits that look like violations and are
  not. A confirmation-shaped prompt scores perfectly on obvious violations and
  fails exactly here, which is exactly where false positives come from;
- it must contain a **null set** — edits that violate nothing at all. Without
  it, a checker that fires on every edit scores 100% recall and looks
  excellent.

## Recommender, never actor

`docs/02-principles.md` (6). What phase 3 does: writes a finding row, surfaces
it through `status`, and lets the atom's check history be queried. That is the
complete list.

What it does not do, and will be asked to do, because a finding that names the
line looks one small step from a patch:

- **It does not edit code**, revert an edit, or stage a change.
- **It does not open a pull request.**
- **It does not deprecate, supersede or reject an atom** because code
  disagreed with it.
- **It does not block a tool call.**

The third one is the interesting case and the one most likely to be argued
for. When a finding says the code contradicts the atom, one of the two is
wrong, and the system genuinely cannot know which. Often it is the atom: the
team changed its mind three weeks ago, edited the code, and never edited the
document. Auto-deprecating the atom would handle that case beautifully — and
it would mean an agent editing code can silently delete a decision. That is
agent self-ratification with the sign flipped, and the database will refuse it
the same way: only a human resolves a finding, and the mechanism is the one
already in `atoms`.

A finding is a question with two human answers. Both of them are edits a human
makes.

## The kill metric

**False-positive rate above 5% and the feature is off permanently.**
`docs/02-principles.md` (10), `docs/14-roadmap.md` phase 3, exit criterion 1.

A false positive here is precisely: a finding with verdict `violated` on an
atom that the code in fact honors, or that does not govern the cited file.
`not_applicable` is not a false positive — it is a retrieval miss, it costs
tokens rather than trust, and counting it here would hide the number that
matters behind a number that does not.

### Why a false positive is so much more expensive than a false negative

**A false negative costs what the user already pays.** They arrived with
silent drift. A missed violation returns them to the status quo for that one
case. It is a disappointment, and disappointments accumulate linearly.

**A false positive costs trust, once, and it does not come back.** The cost is
paid immediately — the user reads the finding, opens the file, reads the code,
concludes the tool is wrong — and the benefit of re-enabling the tool later is
speculative. Nobody re-enables a checker they have already decided cries wolf,
because the decision was never about the aggregate rate. Humans generalise
from about three bad results.

And 5% is not "95% good". It is *one edit in twenty produces a lie*. At a few
dozen edits a day that is several lies a day, arriving in a stream where each
one costs a file-open and a context switch.

**The blast radius exceeds the feature**, which is the part usually missed. A
finding cites a canonical atom. A false positive therefore teaches the user
that *the atom* is noise, not just the checker. The retrieval half of the
product depends entirely on the user believing that a canonical atom is worth
reading. A noisy reconciler discredits the knowledge base it was built to
defend.

So every tuning decision breaks towards silence. The concrete levers, all of
them costing recall on purpose:

| Lever | Effect |
| --- | --- |
| canonical atoms only | removes unreviewed claims from the numerator entirely |
| a citable line required for `violated` | a violation with no artefact cannot be filed |
| `unverifiable` as a first-class verdict | undecidable atoms leave the code queue instead of resolving to a coin flip |
| a low cap on atoms per check | fewer, deeper answers |
| suppression of an already-dismissed finding | a human's "no" is not re-asked until the region changes |
| the burden of proof on the violation, never on the code | silence is the default output |

### Suppression

A finding dismissed by a human on `(atom_id, file_path)` is not raised again
until something changes. Since the server cannot see file content, "changes"
means: the atom was superseded or re-extracted, or the human explicitly
reopens the region. This is a blunt rule and it will occasionally suppress a
genuine violation introduced after a dismissal — a false negative bought
deliberately, at the price the error budget says is cheap.

The exact suppression window is *Open*.

### Measured before launch, monitored after

Phase 3 measures the rate on the committed corpus, and that is the number that
gates shipping. From phase 4 it is also a production number, computable
because a dismissal is a logged row:

```sql
select count(*) filter (where status = 'dismissed')::float
     / nullif(count(*) filter (where status in ('accepted', 'dismissed')), 0)
  from reconciliation_findings
 where project_id = $1
   and verdict = 'violated';
```

The production number is weaker evidence than the corpus number and is not a
substitute for it: a user who has already stopped trusting the feature stops
dismissing findings too, and the rate improves as the product dies. Corpus
gates, production monitors.

## The tables phase 3 adds

Consistent with `docs/04-data-model.md`: every row carries `org_id`, every
table gets `ENABLE` **and `FORCE ROW LEVEL SECURITY`** and the same
`org_isolation` policy scoped to `standfast_app`, and every column appears in
`packages/db/src/schema/wire-allowlist.ts` in the same diff — the equality
test against `information_schema.columns` fails until it does, which is the
point (`docs/02-principles.md`, 9).

Two tables. Sketched as SQL because the constraints are the argument;
`packages/db/src/schema` is the source of truth once written.

### `reconciliation_runs`

```sql
create type reconciliation_trigger as enum (
  'post_edit', 'session_end', 'explicit', 'agent', 'atom_ratified', 'stale'
);

create table reconciliation_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs on delete cascade,
  project_id    uuid not null references projects on delete cascade,
  actor_id      uuid not null references actors,
  trigger       reconciliation_trigger not null,
  verdict_count int  not null check (verdict_count >= 0),
  created_at    timestamptz not null default now()
);
```

One submission, one run. It exists for three things a finding row cannot
carry: which loop produced this work, which actor performed it, and the
grouping that makes "twelve atoms checked, one violation" a query rather than
an inference.

`trigger` is **self-reported by the client and is therefore analytics, never
control.** Nothing gates on it, no policy reads it, and it is a claim rather
than a fact. It is recorded because tuning the loop without knowing which
trigger produces the noise is tuning blind.

The denominator lives here: `verdict_count` makes "checks performed" countable
without scanning findings, and without it the false-positive rate has a
numerator and no denominator.

### `reconciliation_findings`

```sql
create type finding_verdict as enum (
  'honored', 'violated', 'not_applicable', 'unverifiable'
);
create type finding_status as enum (
  'recorded', 'open', 'accepted', 'dismissed'
);

create table reconciliation_findings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs on delete cascade,
  project_id   uuid not null references projects on delete cascade,
  run_id       uuid not null references reconciliation_runs on delete cascade,
  atom_id      uuid not null references atoms on delete cascade,

  verdict      finding_verdict not null,
  file_path    text not null,
  line_start   int,
  line_end     int,
  rationale    text,

  status       finding_status not null,
  resolved_by  uuid,
  resolved_by_kind actor_kind,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- principle 8 as a constraint: a violation without a citable line is
  -- unrepresentable.
  check (verdict <> 'violated'
         or (line_start is not null and line_end is not null)),
  check (line_start is null or line_start >= 1),
  check (line_end   is null or line_end >= line_start),

  -- exactly the violations enter the human queue, and every violation does.
  check ((verdict = 'violated') = (status <> 'recorded')),

  -- an agent cannot dismiss a finding about its own edit. Same mechanism as
  -- ratification: actors is unique on (id, kind), so a row naming an agent's
  -- id must claim kind = 'agent' to satisfy the key, and then fails the check.
  foreign key (resolved_by, resolved_by_kind) references actors (id, kind),
  check (resolved_by_kind = 'human'),
  check (status in ('recorded', 'open')
         or (resolved_by is not null and resolved_at is not null)),

  -- the one free-text field on this path
  check (rationale is null or length(rationale) <= 280),

  -- backstop, not validation: the server has no file tree to check against
  check (file_path <> ''
         and length(file_path) <= 1024
         and file_path !~ '^/'
         and file_path !~ '(^|/)\.\.(/|$)')
);
```

Indexes: `(project_id, status)` for the queue, `(atom_id, created_at desc)`
for an atom's check history, `(project_id, file_path)` for suppression
lookups, `(run_id)` for the grouping.

Three of these constraints are doing the work of a paragraph of documentation
each, and that is deliberate — `docs/04-data-model.md`: a constraint that
lives only in application code is a convention with better marketing.

- **The citable-line check** puts falsification in the schema.
- **The biconditional on `status`** means a non-violation can never appear in
  a human's queue and a violation can never be filed outside it. Without it,
  the queue is whatever the writer of the day remembered to set.
- **The composite ratifier key, reused.** An agent dismissing a finding about
  its own edit would be the reconciliation-shaped version of promoting its own
  knowledge, and `actors (id, kind)` already exists to refuse it.

### Privileges

```sql
grant select, insert          on reconciliation_runs     to standfast_app;
grant select, insert, update  on reconciliation_findings to standfast_app;
```

No `DELETE` on either, and no `UPDATE` on runs. A dismissed finding is the
numerator of our own kill metric, and the product does not get to delete
evidence against itself — the same argument that makes `atom_events`
append-only in migration `0000`.

### Tables deliberately not added

- **A per-atom `last_checked_at` column, or an `atom_check_state` table.**
  Derivable from findings with an index that already has to exist. A
  materialised copy is a second source of truth that can disagree with the
  first, and `docs/02-principles.md` (7) prefers the projection.
- **A `finding_events` log**, mirroring `atom_events`. `atom_events` exists
  from migration `0000` because ratification throughput is a metric whose
  history could not be reconstructed later. Here the surface and the metric
  arrive in the same phase, and `status` + `resolved_by` + `resolved_at`
  computes the rate. If findings ever gain a reopen transition, the log
  arrives with it, and not before.
- **A `reconciliation_due` queue table.** Staleness is a query — canonical
  atoms with no finding since their `ratified_at`, and `(atom, file)` pairs
  whose newest finding is older than the threshold. A table would be a cache
  of a query, invalidated by every ratification.
- **Anything holding a diff, a snippet, a file hash or a file tree.** Not
  deferred; excluded. Each would end invariant 3 in one commit.

### Cascade, and what it costs

`atom_id` cascades on delete, which means a re-extraction that replaces atoms
(`docs/02-principles.md`, 7) also erases their reconciliation history. This is
accepted rather than worked around: a finding about an atom that no longer
exists is not evidence about the system as it now stands, and the
false-positive rate of a previous extraction generation does not predict the
next one. The consequence to hold onto is that the **production** rate is
per-generation and resets, which is another reason the number that gates
shipping is the corpus number.

## Where findings arrive

`docs/03-architecture.md` leaves open whether findings arrive over the same
`/v1` surface or a distinct ingest path with a narrower schema, and assigns
the answer here.

The question conflated two things. **Same surface, distinct route, narrowest
schema in the API.** Findings arrive at
`POST /v1/projects/{projectId}/reconciliations`, under the same
`requireApiKey` middleware, the same `asTenant` → `withActor` path, and the
same `@hono/zod-openapi` generation as everything else — a second ingress
would be a second auth path and a second tenancy boundary, and there is no
version of that which is safer.

What is distinct is the **request schema**, which does not share a type with
anything and is never widened by inheritance. It is the only schema in the API
that is itself a security control, so it gets its own test asserting that the
set of accepted fields is exactly the table above — the schema equivalent of
the wire allowlist, in the other direction. `docs/14-roadmap.md` phase 3 exit
criterion 2 is that test.

Submission is a single call carrying every verdict for the run: one
transaction, one run row, N findings. A per-finding endpoint would make a
partially-submitted run representable, and a run missing half its `honored`
verdicts has a broken denominator.

## What the human sees

Drift surfaces through `status` (`docs/08-mcp-server.md`), which already
reports the provisional queue and gains open findings alongside it. The two
belong together: both are counts of things waiting on a human, and both are
the bottleneck `docs/02-principles.md` (5) makes a first-class metric.

`honored` and `not_applicable` are never shown as findings. They are coverage
and freshness — *"eleven canonical atoms govern this file, all checked within
the week"* — and presenting them as results would be presenting the absence of
disproof as proof, which the vocabulary section exists to prevent.

## Open

- **Whether the rationale field survives at all.** `docs/14-roadmap.md`
  already lists this. The two decisions above — hard cap, never returned to an
  agent — reduce the blast radius and do not close the hole. Deleting the
  field entirely remains on the table and would cost the human queue its only
  human-readable explanation.
- **Whether the server records what it offered.** As designed, a run is
  whatever the agent submitted, so an agent given twelve atoms that returns
  three is indistinguishable from an agent given three. Detecting that needs
  the retrieval call and the submission correlated, which needs either a field
  on `context`'s output or a second tool call — and the tool budget
  (`docs/02-principles.md`, 3) forbids the second.
- **The cap on atoms per check**, and the suppression window. Both are
  numbers, neither has been measured, and inventing them before the corpus
  exists is the failure principle 10 describes.
- **Whether `honored` verdicts are stored at all**, or whether a run-level
  count is enough. Storing them gives coverage reporting and the denominator;
  it also writes a row per atom per check forever.
- **Which model performs the check.** It runs in the customer's session, so it
  is their model, and the false-positive rate is therefore model-dependent. A
  number measured on one model does not transfer to another. Whether the
  corpus is labelled per model, or the exit criterion names a reference model,
  is undecided — and it has to be decided before the 5% means anything, since
  `docs/14-roadmap.md` requires the number be reproducible by someone who did
  not run it first.
- **What `file_path` is relative to.** The server has no file tree, so the
  root is whatever the client declares. Whether a project needs a declared
  root, and what happens in a monorepo where two agents disagree about it, is
  unresolved.
- **Whether `context` may accept a diff** (`docs/08-mcp-server.md`, *Open*).
  From this side the answer is constrained rather than open: a unified diff
  contains source. A list of changed paths does not. `docs/08-mcp-server.md`
  owns the final wording; this document only records that one of the two
  readings is unavailable.

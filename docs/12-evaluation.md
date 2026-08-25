<!-- docs/12-evaluation.md -->
# Evaluation

> **Status: the harness exists; the labels do not.** The four numbers are
> settled — they are named in `docs/01-thesis.md` and each is assigned to
> exactly one phase by `docs/14-roadmap.md`. `eval/` is now a workspace package
> with the corpus manifest, the label format, the scoring functions, the
> regression rules and `pnpm eval check` running on every pull request. What it
> does **not** have is a single label, because a system does not grade itself
> and no human has sat down with the corpus yet. Three of the four bars have no
> value, and `eval/baselines.json` records them as `null`. Where a target is
> unknown this document says unknown rather than choosing one: choosing one
> before a corpus exists is precisely the failure `docs/02-principles.md` (10)
> describes.

## What this document fixes

`docs/02-principles.md` (10): *"Measure before you tune. The evaluation harness
precedes optimization."* The anti-pattern list is blunter: *do not tune a
threshold without a labelled corpus.*

`docs/14-roadmap.md` turns that into a schedule — the harness is not a phase,
it is a precondition **inside** each phase, sitting between the "make it work"
half and the "make it good" half. That leaves three things undecided, and they
are what this document fixes.

1. **What each of the four numbers actually counts.** A metric named in a
   sentence is not a metric. "Extraction precision" has at least four plausible
   denominators and they disagree with each other by a lot.
2. **Where the labelled corpus comes from and who writes the labels**, given
   that the system under test is model-driven and the obvious cheap labeller is
   a model of the same family.
3. **How a regression is caught before it ships**, given that two of the four
   numbers call a model and therefore cannot be gated on a pull request the way
   `infra/openapi/openapi.json` is.

## Gates are not measurements, and the distinction is load-bearing

`docs/14-roadmap.md` already separates them in its exit criteria, and the
separation has to survive into the harness or the harness will be asked to
carry work it is bad at.

A **gate** is a property that is true or false over the whole database, with no
sampling and no judgement. Zero atoms whose `source_quote` does not equal
`substring(section.body …)` at `source_span`. Every assembled pack at or under
`budget_tokens`. Re-running extraction over an unchanged project enqueues zero
jobs. These belong in the integration suite, run on every pull request, and
they are cheap because there is nothing to label.

A **measurement** is a number derived from human judgement on a sample. All
four of the thesis numbers are measurements. They are expensive, noisy, and
cannot be asserted with `expect(x).toBe(0)`.

Two failure modes come from confusing them, and both are common:

- Reporting a gate as a quality number. "100% of quotes verify" sounds like an
  extraction score and is not one. It says the quote is real. It says nothing
  about whether the statement follows from the quote, which is the whole of
  extraction precision.
- Turning a measurement into a gate by picking a threshold before the corpus
  exists. That threshold then gets tuned against, and the number it produces
  measures how hard someone tried.

The harness owns measurements. CI owns gates. Where the two meet is
*Regression*, below.

## The four numbers

| Number | Phase | Bar | State of the bar |
| --- | --- | --- | --- |
| Extraction precision | 1 | unknown | chosen from the first full run on the corpus |
| Retrieval precision under a fixed token budget | 2 | unknown | chosen from the first full run on the corpus |
| Reconciliation false-positive rate | 3 | **< 5%** | settled in `docs/14-roadmap.md`; tighten-only |
| Ratification throughput | 4 | unknown | needs an arrival rate to be meaningful |

Three of the four are blank on purpose. `docs/00-handoff.md` lists the same
gap, and `docs/14-roadmap.md` records it under *Open*. What this document adds
is **how each blank will be filled**: from the first full run of the harness on
the committed corpus, once, with the run committed alongside the number. Not
from a figure in a paper about a different task on a different corpus.

Each metric below states four things: what is counted, on what corpus, how a
labelled example is produced, and what passing looks like.

---

## 1. Extraction precision — phase 1

### What is counted

Of the provisional atoms produced from a labelled section, the fraction a human
labeller accepts as a decision, convention or constraint that the section
actually states.

The denominator is **atoms emitted**, not sections processed and not atoms
ratified. Ratified is the wrong denominator because ratification is phase 4 and
because it would make the metric a measurement of the reviewer's patience.

Rejections split into three classes, counted separately, because they have
different causes and different fixes:

| Class | Meaning | Fix lives in |
| --- | --- | --- |
| unsupported | the statement does not follow from the quote | the extraction prompt |
| not knowledge | true and quoted, but a passing remark, an example, a TODO | the extraction prompt |
| duplicate | restates an existing canonical atom | the deduplication bands |

The *unsupported* class deserves care, because it is the one people assume the
verbatim gate already covers. It does not. Phase 1's exit criterion 1 proves
the **quote** appears in the section. It cannot prove the **statement** is
entailed by the quote, and a model that quotes accurately while inferring
freely passes the gate and fails the metric. That gap is the reason extraction
precision exists as a separate number rather than as a corollary of the gate.

*Miscategorised* — right statement, wrong `kind` — is recorded and reported but
is **not** counted as a precision failure. A wrong `kind` degrades retrieval
filtering; it does not put a false claim into the knowledge base. Folding it in
would let a retrieval problem consume the budget of a trust problem.

Recall is measured and reported. It is deliberately not the bar; see
*Considered and declined*.

### Corpus

Markdown sections, in three tiers, all committed under `eval/`:

1. **This repository's `docs/`.** Ours to publish, and exactly the genre Standfast
   ingests: decisions with arguments attached. Also a known bias — these
   documents were written by people who know what an atom is, so they are
   easier than a real customer's `CONTRIBUTING.md`. Reported as its own slice
   so the bias is visible rather than averaged away.
2. **Public repositories under permissive licences**, chosen by an allowlist
   recorded in the corpus manifest with licence and commit SHA per document.
   ADR directories, `CONTRIBUTING` files, RFC folders, style guides. Allowlist
   rather than denylist, for the reason in `docs/02-principles.md` (9): a
   denylist has to anticipate the licence nobody thought to exclude.
3. **Written-for-purpose documents**, only where a class is otherwise
   unrepresented, marked synthetic in the manifest and reported as a separate
   slice.

Not customer documents, ever. See *No customer data*, below.

### How a label is produced

A labeller reads a section and writes the atoms they would expect, each with
the sentence it comes from. **They do not see the extractor's output.** Then,
separately, the extractor runs and each emitted atom is adjudicated against the
label set.

The blind-first ordering is the entire method, not a nicety. A labeller shown a
model's proposals grades them, and grading is not labelling: it anchors on what
is present and is structurally incapable of noticing what is absent. The recall
figure from a grading pass is meaningless, and the precision figure is inflated
by the anchor.

A sample is double-labelled and inter-labeller agreement is published beside
the precision figure. A precision number with no agreement number is a
statement about one person's taste. What that agreement will be is unknown.

### Deduplication is measured on its own corpus

`docs/00-handoff.md` settles cosine < 0.80 distinct, > 0.93 merge, LLM judge in
between, *"to be recalibrated on a real corpus"*. Recalibration needs a second
corpus that the extraction corpus does not provide: **pairs of atoms labelled
same-claim or different-claim by a human**.

The labels must be human and must not be derived from the embedding. The
anti-pattern list says *do not mistake vector similarity for claim identity*;
labelling pairs by cosine and then fitting cosine bands to those labels is that
sentence executed as a procedure.

The LLM judge in the intermediate band is part of the system under test. It
does not get a vote on the labels that grade it.

### What passing looks like

Unknown, and it stays unknown until the first run. Two things can be said now:

- A non-zero *unsupported* rate is a **gate failure**, not a low score. The
  quote verification should have made it unrepresentable, and if an unsupported
  atom exists in the database at all, phase 1's exit criterion 1 is false.
- The bar, once chosen, moves in one direction. It can tighten on evidence and
  cannot loosen, for the same reason `docs/14-roadmap.md` gives for the kill
  metric: loosening contradicts principle 10 rather than merely disappointing
  it.

---

## 2. Retrieval precision under a fixed token budget — phase 2

### What is counted

Given a query — a task description, a list of file paths, or both — and a
`budget_tokens`, the fraction of the atoms in the assembled pack that actually
govern the work.

The qualifier is the metric. Precision at *k* is the wrong shape here, because
the pack is not *k* items; it is however many items fit. An assembler that
returns one perfect atom and stops scores 1.0 at every *k* and is useless, and
that failure mode is not hypothetical — it is the local optimum of any
precision-only objective under a budget.

So the figure is never reported alone. Three numbers travel together:

| Reported | Why it is needed |
| --- | --- |
| precision over the delivered pack | the headline |
| budget tokens used | 1.0 at 3% of budget is not a good result |
| **displacement** — governing atoms that existed and did not fit | the recall side, in the units the user feels |

The budget itself is a gate, not a measurement: `docs/14-roadmap.md` phase 2,
criterion 1, *the assembler respects the budget; it does not approximate it*.
The harness asserts it and moves on.

A single figure at a single budget can be tuned into existence. The harness
reports a curve across at least three budgets, and the shape of that curve —
whether precision collapses as the budget tightens — is more informative than
any point on it.

### Corpus

The query set is paired with the atoms from the extraction corpus, after those
atoms have been ratified by a human. For each query, a labeller names which
atoms govern it. Queries come from three places:

- **Real task descriptions**, taken from this repository's commit messages and
  issue titles. These are the shape of a `UserPromptSubmit` payload, which is
  where `context` is actually called from (`docs/08-mcp-server.md`).
- **File paths** from the corpus repositories, for `scope: "file"`.
- **Written queries** against the corpus, for coverage of cases the first two
  miss.

### The contamination hazard specific to retrieval

If the person writing a query has just read the atom, the query will use the
atom's vocabulary, and every lexical generator will look excellent for a reason
that has nothing to do with retrieval quality.

The countermeasure is procedural: queries are written from the **code and the
task**, not from the atom list. A deliberate share of the set is paraphrased
away from the atom's wording and reported as its own slice. That paraphrase
slice is the only part of the query set that distinguishes the semantic
generators from the lexical ones; without it, RRF fusion weights would be tuned
on a set where the lexical generator cannot lose.

### The reranker measurement, which the harness owes phase 2

`docs/02-principles.md` (4) admits both of the read path's model calls — the
query embedding and the cross-encoder reranker — as pinned and bounded, under
the five conditions `docs/06-retrieval.md` states. The amendment was narrow:
it draws a line at *generative*, and a line drawn is a line that has to be
defended with evidence rather than with wording.

What this document owes it is a number. The harness reports
retrieval precision **with and without the reranker, on the same corpus, at the
same budgets**. If the delta is small, the reranker is not worth its latency
and drops out, and the narrower reading never has to be exercised. If it is
large, what the amendment bought is a figure rather than an assumption, which
is the only honest way to justify widening a principle.

### What passing looks like

Unknown. The pair (precision, budget) is the unit; a bar stated without a
budget is not a bar.

---

## 3. Reconciliation false-positive rate — phase 3, the kill metric

`docs/02-principles.md` (10): *above 5%, users switch the feature off and never
switch it back on.*

### What is counted

`docs/07-reconciliation.md` owns the definition: a false positive is a finding
with verdict `violated` on an atom the code in fact honors, or on an atom that
does not govern the cited file. A `not_applicable` verdict is a retrieval miss
and is not counted here.

What this document owns is the denominator, and it is not obvious.

**On the corpus, the denominator is findings emitted, not edits examined.** A
reconciler that examines a thousand edits, emits four findings and gets one
wrong is at 25%, not 0.1%. The per-edit reading would report 0.1% and would be
describing an experience nobody has: the user does not see the 996 silent
edits. They see four notifications, one of which was wrong.

**In production the denominator narrows again**, to findings a human actually
adjudicated — `dismissed / (accepted + dismissed)`, the query in
`docs/07-reconciliation.md`. These are two different measurements and must
never be reported as one series. The corpus denominator includes findings
nobody would have looked at; the production denominator excludes findings a
disengaged user has stopped triaging, which is why that document says the rate
improves as the product dies. Corpus gates, production monitors.

A consequence follows for either denominator. At low finding counts the rate is
unstable — one bad finding out of eight is 12.5% — so the harness reports it
with a confidence interval and **refuses to report at all** below a minimum
number of findings. That minimum is a function of the 5% bar and the interval
width the decision can tolerate. It is computed once the corpus exists. It is
not guessed here.

The false-negative rate is measured and published beside it, and never
optimised. `docs/07-reconciliation.md` lists six tuning levers that all cost
recall on purpose; the harness's job is to keep the price of that visible,
because **the degenerate optimum of a kill metric is silence** — a reconciler
that emits nothing scores zero. Printing the miss rate next to the headline is
the cheapest available defence against a system optimising itself into
uselessness while its headline number improves.

### Corpus

Labelled edits: a diff, the atom it was checked against, and a human verdict.
Constructed rather than found, because naturally occurring violations are rare
and arrive in an unrepresentative mix. Four slices:

| Slice | Construction | Expected |
| --- | --- | --- |
| seeded violation | break a convention the repository states | `violated` |
| **seeded near-miss** | looks like a violation, is not — exempt file, honored by another mechanism, test fixture | `no finding` |
| innocent edit | unrelated change | `no finding` |
| legitimate drift | the code changed for a good reason and the document is now stale | `violated` |

The near-miss slice is where false positives come from, and it must be the
largest of the four. The innocent slice must be the majority of the corpus by
volume, because in production most edits are unrelated to any atom, and a rate
measured on a corpus of violations is not the rate a user experiences.

The legitimate-drift slice is not a false positive — the finding is correct —
but it is counted apart, because it is the case where the right response is
editing the document, and a system that cannot tell it from a violation will be
described by users as wrong even when the metric says it is right.

The corpus mix should approximate the production mix. The production mix is
unknown until phase 4, and that is recorded under *Open* rather than assumed.

### How a label is produced

A human reads the diff and the atom and decides. For the near-miss slice
especially, **the labeller is not the person who constructed the example**: the
author of a near-miss knows it is a near-miss and will label it correctly for a
reason the system does not have access to.

Prompts on the reconciliation path are written to falsify
(`docs/02-principles.md`, 8) — the agent is asked what would disprove the atom.
The labelling instruction is written the same way, for the same reason.

### What passing looks like

Below 5% on the labelled corpus. `docs/14-roadmap.md` records this as phase 3's
exit criterion; `docs/00-handoff.md` still calls it *proposed*. The roadmap
wins. The bar can tighten on evidence and cannot loosen.

### What happens operationally when it is exceeded

Two regimes, and they are not the same thing.

**Before phase 3 ships.** At 6%, the phase does not ship. Not behind a flag,
not with a mitigation plan, not for design partners. `docs/14-roadmap.md` fixes
this, and the harness's only job here is to make the number unarguable: the
corpus, the run, the model version and the configuration are all committed, so
anyone can reproduce the figure and nobody has to litigate it.

The temptation this rule exists to defeat is specific. At 6% the work is done
and the demo is impressive, and the honest reading — one finding in sixteen is
a lie — sounds survivable. `docs/07-reconciliation.md` argues at length why it
is not, and that argument is not repeated here. What belongs here is the
consequence for the harness: the figure has to be reproducible by someone who
disagrees with it, or the conversation at 6% is settled by whoever is most
tired.

**After phase 4, in production.** It becomes a monitored number, and a
regression above the bar is an incident rather than a backlog item. Three
things have to be true for that sentence to mean anything.

1. **There must be a production label.** Settled:
   `docs/07-reconciliation.md` gives findings an explicit `dismissed` state
   distinct from `accepted`, and a dismissal is the label. The dependency is
   worth naming because it is fragile in one direction — collapse those two
   states into one and the production rate stops being computable, leaving the
   kill metric frozen at whatever the pre-launch corpus said.
2. **The system must be able to stop emitting.** Continuing to emit at a rate
   known to exceed the bar spends the trust the product exists to hold.
   Per project, not globally: the rate is a property of one project's atoms,
   and one customer's badly worded atoms should not silence another customer's
   reconciliation. `docs/07-reconciliation.md` settles per-finding suppression
   after a dismissal; a project-level stop is not settled anywhere, and is
   listed under *Open*.
3. **Silencing itself is not a violation of principle 6.** *Recommender, never
   actor* is about the customer's code and knowledge — the system does not fix
   code, deprecate atoms or open pull requests. Declining to speak is not an
   action taken on the customer's behalf. The sentence is here because a reader
   will reasonably wonder, and the answer should be written down once.

---

## 4. Ratification throughput — phase 4

`docs/02-principles.md` (5): ratification is the real bottleneck, so its
throughput is a first-class product metric, not an interface detail. This is
the only one of the four with no labelled corpus, because the human's decision
*is* the label.

### What is counted

Throughput alone is not interpretable. If atoms arrive faster than they are
decided, the queue diverges however good the throughput figure looks. So the
headline is a **pair**:

- **arrival rate** — provisional atoms created per unit of time;
- **clearance rate** — atoms decided (ratified or rejected) per unit of time,
  per human.

The derived question is whether the backlog is growing. Two supporting
distributions make a bad answer diagnosable:

- **decision latency** — from `proposed` to the first deciding event, reported
  as median and p90, never as a mean. The mean is dominated by the one atom
  nobody ever opened.
- **queue age** — the age of the oldest undecided provisional atom, and the
  backlog size. This is the number that predicts abandonment, which is the
  failure the metric exists to see coming.

### How it is computed, from `atom_events`

`packages/db` carries an append-only `atom_events` table from the first
migration, with no consumer in phase 0. The schema comment says why: *a metric
nobody recorded cannot be computed retroactively*. This is the section that
cashes that.

The table, as implemented in `0000_foundation` and extended by `0011` and `0012`:

| Column | Notes |
| --- | --- |
| `id`, `org_id` | `org_id` carries the RLS policy like every other table |
| `atom_id` | FK to `atoms (id, org_id)` on `(atom_id, org_id)`, `on delete cascade` |
| `event` | enum: `proposed`, `ratified`, `rejected`, `superseded`, `retired` |
| `actor_id` | FK to `actors (id, org_id)` on `(actor_id, org_id)`; `actors.kind` is `human` or `agent` |
| `reason` | enum, nullable, only on `event = 'rejected'`; nothing writes it yet |
| `reason_note` | text, nullable, ≤ 280 characters, same constraint; nothing writes it yet |
| `at` | `timestamptz not null default now()` |

Every quantity above is a query over that table alone:

- **arrival rate** — count of `event = 'proposed'` per time bucket.
- **clearance rate** — count of `event in ('ratified', 'rejected')` per bucket,
  joined to `actors` on `actor_id` and filtered to `kind = 'human'`. The join
  is not decoration: `actor_kind` is what makes "per human" mean something in a
  table that also records what agents did.
- **decision latency** — `at` of the deciding event minus `at` of the
  `proposed` event for the same `atom_id`.
- **queue age and backlog** — `proposed` rows with no later deciding event for
  the same `atom_id`.

The two indexes the migration already creates are exactly the two these queries
need: `atom_events_at_idx` for bucketing, `atom_events_atom_id_idx` for pairing
an atom's proposal with its decision.

**Why append-only matters for the metric, not only for audit.** `standfast_app` is
granted `SELECT, INSERT` on this table and nothing else
(`docs/03-architecture.md`). If a row could be updated, a re-decision would
overwrite the first one and the original interval would be gone — and the
interval is the metric. The grant is what makes the history reconstructable,
which is a stronger reason to keep it than tamper-evidence.

**What phase 0 actually writes, which is half of it.**
`packages/db/src/repositories/atoms.ts` inserts `proposed` on create and
`ratified` on ratify. Nothing writes `rejected`, because there is no reject
endpoint, and nothing writes `superseded`, because `atoms.superseded_by` has no
writer (`docs/14-roadmap.md` says so plainly). Clearance as defined above
counts decisions, and a rejection is a decision. **Phase 4 must add the
rejection path, or the clearance rate counts half the work and the backlog
looks permanently worse than it is.** That is a requirement on phase 4 derived
from the metric, and it is the kind of thing that is cheap to notice now and
expensive to notice from a dashboard.

### Corpus, and why there is not one

There is no labelled corpus, because there is no ground truth to label. This
makes ratification throughput the only one of the four that cannot be measured
before launch.

A synthetic version is worth running once — replay a queue of provisional atoms
against a person and time them — but it measures the review interface, not the
metric. It is a usability test and should be called one.

### What passing looks like

Unknown, and unusually so: throughput has no natural scale. The one statable
shape is **clearance at or above arrival over a rolling window**. Below that,
the backlog diverges, canonical knowledge ages, and every other number in this
document decays behind it.

### Privacy

`atom_events` holds no prose: an id, an org, an atom id, an enum, an actor and
a timestamp. Its column set is in `packages/db/src/schema/wire-allowlist.ts`.
Nothing about this metric requires a customer's documents to leave anything,
and the production figure is computed inside the customer's own tenant.

---

## The labelled corpus

### Where it comes from

Recorded once here, and the same three tiers apply to every metric that has a
corpus: this repository's own `docs/`; public repositories under permissive
licences, chosen by an allowlist and recorded with licence and commit SHA;
written-for-purpose material only where a class is otherwise unrepresented, and
always marked synthetic.

The manifest is not bureaucracy. A corpus whose provenance is unrecorded cannot
be rebuilt, cannot be audited for licence compliance once it is committed to a
public repository, and cannot be re-labelled when the definitions change.

### Who labels

People on this team. This is not a placeholder for "we will find labellers".
`docs/01-thesis.md` says the human ratification gate *is* the mechanism that
produces trust; a team unwilling to sit down and label two hundred sections is
a team that has not felt the thing it is asking every customer to do daily.

Blind-first, double-labelled on a sample, agreement published with the figure.

**Considered and declined: an LLM labeller.** It is the obvious cost saving and
it is the anti-pattern wearing a good suit. The corpus's job is to be an
independent check on a model-driven pipeline. Label it with a model of the same
family and the harness agrees with the extractor exactly where the two share a
blind spot — and the failure is invisible, because both numbers look fine. The
deduplication design already puts an LLM judge in the 0.80–0.93 band; that
judge is the system under test, and a system does not grade itself.

One narrow exception is allowed: a model may **propose candidate labels for a
human to accept or reject**. Even that costs the blind-first property, so it is
off by default, and any run whose labels were produced that way is marked as
such in its output.

### How contamination is avoided

Four rules, each defeating a specific and observed way of getting a good number
for no reason:

1. **Blind-first.** Labels precede seeing the system's output, for every metric
   that has labels. Defeats anchoring.
2. **No labelling from system output.** There is no "accept the atoms that look
   right" pass. That builds a corpus the system scores well on by construction.
3. **A held-out split, held out from people as well as from code.** Prompts and
   thresholds are fitted on the tuning split. The held-out split runs rarely,
   its per-example results are not read, and only the aggregate is reported. A
   held-out set whose individual failures someone studied is a tuning set with
   extra ceremony.
4. **Retirement is scheduled, not noticed.** After a fixed number of reported
   runs, the held-out split is retired and replaced. How many is unknown; the
   rule is that the count is decided in advance rather than argued about on the
   day someone wants one more run.

One hazard is specific to us: this repository's own documents describe the
extractor. A section explaining what an atom is will be extracted unusually
well, for reasons no customer benefits from. That slice is reported separately
and never folded into the headline.

### No customer data

The corpus contains no customer documents. Three reasons, in descending order
of how much they would cost to get wrong:

- Copying customer prose into a repository is the shortest available route to
  breaking the spirit of invariant 3, even though its letter is about source
  code.
- A benchmark nobody outside can run is a marketing claim. The corpus is
  committed so that a fresh clone reproduces the number.
- The realism a customer corpus would buy is available without the copy: from
  phase 4, the production numbers are computed in the customer's own tenant
  over `atom_events` and reconciliation findings, neither of which carries
  prose. Nothing is copied into `eval/`.

The mechanism, not the promise: the runner takes a corpus directory and a
database URL that it populates itself. It has no code path that reads from a
production database, and no configuration that would give it one.

---

## Where the harness lives, and how it runs

### Location

`eval/`, a private workspace package. `pnpm-workspace.yaml` lists it by name
beside the `packages/*` glob.

It stays outside `packages/` deliberately. The seven packages in
`docs/03-architecture.md` are things that ship or serve; the harness is
neither, and keeping it out of the glob makes "no product package may depend on
the harness" a structural fact rather than a convention someone has to
remember. The dependency is one-way and it is a leaf: the harness imports
`core` — it needs `sectionMarkdown` to build labelled sections the same way the
pipeline does — and, for the retrieval metrics, `db`. Nothing imports it.

That import list settles its licence: it links AGPL packages, so `eval/` is
AGPL-3.0-only. The obligation binds nobody in practice, because the package is
`"private": true` and is never published — but the rule from
`docs/03-architecture.md` still holds in the direction that matters. **No
Apache package may depend on `eval/`.**

Layout:

```
eval/
  corpus/         documents, with a manifest: source, licence, commit SHA
  labels/         label sets, one per (document, labeller)
  runs/           committed results, one file per run
  baselines.json  the current number for each of the four
  src/            the runner; src/metrics/ is pure and unit-tested
```

Corpus documents are **copied** into `eval/corpus/`, not read from `docs/`. A
corpus is a snapshot: editing `docs/02-principles.md` must not silently
invalidate a label written against a sentence it used to contain. The manifest
records the commit each copy was taken at, so refreshing the corpus is a
deliberate act with a diff, and `pnpm eval check` verifies the copy still
hashes to what the manifest says.

The corpus's own identity is the hash of its document ids and content hashes,
not the repository SHA. A run pins the documents it measured; the repository
moves for reasons that have nothing to do with the corpus, and a repository SHA
would make every run look incomparable with every other one.

A committed run records the metric, the corpus revision, the code revision, the
**three** models, the extractor version, the coverage, and the configuration. A
number missing any of them is not reproducible.

Three models rather than one, because phase 1 has three and each changes the
output in a different way: the extractor decides what is proposed, the embedder
decides what survives deduplication, and the judge decides the intermediate
band. A run that recorded "the model" would name whichever of them somebody
thought was the interesting one.

The extractor version is the opaque string in `section_extractions`. It is
derivable from the models and the thresholds in principle, and recorded anyway,
because it is what joins a number back to the rows that produced it — and
because the derivation lives in code that will change.

Coverage is the per-tier count of labelled sections the run actually read, and
it exists so `slice` is evidence rather than a claim. The schema refuses a run
that declares the headline slice while having read nothing but this
repository's own documentation. Structural rather than conventional, because
the first run is the one that sets a bar and a bar only tightens afterwards. Model version especially — it is the
one input that can change with no diff on our side.

### The label file

JSON, one file per (document, labeller), at
`labels/<document id>.<labeller>.json`. `pnpm eval skeleton <document>
<labeller>` writes a blank one with every section listed and nothing expected.

Each entry is keyed by **`sectionHash`**, which is what makes labels survive a
document being reordered: `sectionHash` covers the heading path and the body
and deliberately excludes the ordinal (`docs/05-extraction.md`). An expected
atom carries a statement, a `kind`, and a verbatim `quote` from the section
body — checked on every run, for the same reason the database checks it on
write.

An empty `expect` is a label: it says the section states no decision,
convention or constraint. A section with **no entry at all** is unlabelled.
Collapsing the two would make recall unmeasurable, because a missed atom and a
section nobody read would count identically.

Labels are versioned **with** the corpus document, through a `documentHash`
field, not independently. Independent versioning lets labels and documents
drift apart, which is worse than the alternative it avoids. When the corpus is
refreshed, `check` reports exactly the sections whose hash moved as needing
re-labelling and leaves the rest standing; a document that moved with no
labelled section moving is a warning, not an error.

Every set records `blind` and `modelAssisted`. Both are reported, and any run
carrying a set with `blind: false` or `modelAssisted: true` prints as
contaminated in its own summary.

### How it runs

Locally, `pnpm eval <command>`, against the same Postgres the README already
starts with `docker run … pgvector/pgvector:pg16`. It needs a database because
retrieval is a database query. It does not need a customer, an account, or a
network path to anything of ours.

| Command | What it does |
| --- | --- |
| `pnpm eval check` | corpus integrity, label validity, coverage, agreement |
| `pnpm eval skeleton <doc> <who>` | a blank label set for one document |
| `pnpm eval score <run-file>` | the metrics of an adjudicated run |
| `pnpm eval extraction` | the extractor over the corpus |

Exit codes: `0` success, including a loud skip; `1` a failure or a regression;
`2` a usage error.

The existing suite sets the precedent for degrading cleanly, and the harness
follows it exactly. `vitest.config.ts` excludes `*.integration.test.ts` unless
`DATABASE_URL` is set, so a fresh clone is green offline. By the same shape:

| Missing | Behaviour |
| --- | --- |
| `DATABASE_URL` | deterministic slices run; retrieval slices skip, loudly |
| model credentials | extraction and reconciliation slices skip, loudly |
| nothing | the full run |

Loudly is the operative word. A skipped metric that reports as a pass is the
same class of failure as `truncated` inferred from `returned < total`
(`docs/08-mcp-server.md`): a caller that believes it has seen everything
reasons confidently and wrongly.

In CI, the split is by cost rather than by importance:

- **Every pull request** runs everything deterministic — the gates, the
  retrieval metrics over a fixed embedding fixture, and the throughput queries
  over a fixture event log.
- **On a schedule** runs everything that calls a model: extraction precision,
  the deduplication bands, reconciliation.

The reason is not only money. Secrets are not available to a pull request from
a fork, so the model-calling half *cannot* run there, and pretending otherwise
would produce a check that is green because it did nothing. The schedule is
where those two numbers actually come from, and *Regression* below is written
around that constraint rather than against it.

---

## Regression

The repository already has three working examples of the pattern this needs,
and naming them is worth more than inventing a fourth mechanism:

- `packages/mcp/src/budget.test.ts` fails the build when the tool-description
  catalogue grows past its committed budget.
- The OpenAPI drift check regenerates `infra/openapi/openapi.json` and fails on
  a diff.
- The SDK drift check does the same for `packages/sdk/src/schema.d.ts`.

The shape in all three: **the number is committed, and the build compares
against the committed number.** Applied to the four:

1. **A committed baseline per metric**, in `eval/baselines.json`, each with the
   run that produced it.
2. **A downward move beyond the noise band fails.** The band is not zero: these
   are sampled metrics, and one example flipping on a two-hundred-example
   corpus is not a regression. The band is computed from the corpus's measured
   variance, not chosen for convenience, and it is unknown until the corpus
   exists.
3. **An upward move also fails, until the baseline is updated in the same
   diff.** Same argument as the committed OpenAPI artifact. A silent
   improvement is an unreviewed change to a number the product is judged on,
   and — more usefully — it is the only cheap way to catch an improvement that
   came from the corpus getting easier rather than the system getting better.
4. **The kill metric is a hard threshold, not a delta.** Any run at or above 5%
   fails, regardless of the baseline. A delta rule would let it walk from 1% to
   4.9% across ten individually green pull requests, each defensible, arriving
   at a product nobody would have shipped in one step.
5. **Scheduled regressions block a release, not a commit.** A number whose
   variance is dominated by something outside the repository cannot honestly
   gate a pull request. When a scheduled run regresses, it opens an issue and
   holds the next release. This is also the mechanism that catches a provider
   changing a model under us, which will happen and will produce a regression
   with no diff to blame.
6. **Seeds and versions pinned wherever pinning is possible**, and recorded per
   run. A moved number that cannot be attributed to a change is a moved number
   nobody will act on.

---

## Considered and declined

Recorded so each question is asked once.

- **An LLM labeller for the corpus.** Marking your own homework; the
  deduplication judge is part of the system under test. Argued above.
- **Customer documents in the corpus.** Breaks the spirit of invariant 3 and
  makes the benchmark unreproducible by anyone outside. Production realism
  arrives instead as tenant-local aggregates over `atom_events`.
- **Recall as the extraction bar.** Measured and reported, never the bar. A
  missed atom leaves the user where they started: a decision sitting in a
  Markdown file that nothing checks — the status quo. A wrong atom gets
  ratified by a tired human and is then injected into every future session as a
  directive (`docs/02-principles.md`, 13). Errors of commission compound;
  errors of omission do not.
- **One combined "quality" score.** It would let a gain in retrieval offset a
  loss in reconciliation, which is exactly the trade the kill metric exists to
  forbid. Four numbers, reported four ways.
- **Measuring on the tuning split.** The number goes up and nothing improves,
  and it feels like progress the whole time it is happening.
- **Snapshot-testing extractor output.** It fails on every harmless rewording
  and passes on a semantic regression, which trains a team to update snapshots
  without reading them. Worse than no test.
- **Waiting for real usage before building the harness.** That is the ordering
  principle 10 forbids, and `docs/14-roadmap.md` already makes the harness a
  precondition inside each phase for this reason.
- **A public leaderboard.** The corpus is committed and the runs are committed,
  which is the reproducibility part. Competing on a number is how a number
  stops measuring anything.

---

## Open

- **The three unchosen bars** — extraction precision, retrieval precision under
  budget, ratification throughput. `docs/14-roadmap.md` records the gap; what
  is settled here is only the procedure for closing it. The numbers are still
  unknown and nothing in this document should be read as implying otherwise.
- **Corpus size.** How many labelled sections, queries and edits are enough is
  a function of variance, which is unknown until there are labels. The first
  corpus is sized by what the team can label blind inside a fixed time-box; the
  resulting confidence interval is reported, and if it is wider than the
  decisions it has to support, the corpus grows.
- **The minimum finding count** below which the reconciliation false-positive
  rate is not reported at all.
- **The noise band** for regression gating, per metric.
- **Whether the held-out split is per-metric or shared**, and how many reported
  runs retire it.
- **Whether CI uses a cached embedding fixture or the real provider.** Caching
  makes retrieval numbers deterministic and gateable per pull request, and
  makes a provider change invisible until the scheduled run catches it.
- **How far back a throughput series survives a re-projection.**
  `atom_events.atom_id` is `on delete cascade`, so deleting an atom deletes its
  history. `docs/05-extraction.md` closes the dangerous half of this — phase 1's
  re-projection matches against existing atoms rather than deleting them, so
  ratification survives a model change — and it also states plainly that
  `delete from atoms` followed by a re-run destroys every human decision ever
  recorded. That leaves one thing undecided for this document: whether a
  throughput series is allowed to span an event a re-projection *did* remove
  rows for, or whether the series must be cut at that point and reported as two
  segments. Reporting across a discontinuity without saying so would show a
  clearance improvement that is a deletion.
- **Whether the corpus is labelled per checking model, or the exit criterion
  names a reference model.** `docs/07-reconciliation.md` records this as open,
  and it lands on the harness: the false-positive rate is a property of the
  model doing the check, so a number measured with one model does not transfer
  to another. Until it is decided, every committed run records the model and no
  two runs on different models are compared.
- **A project-level stop on emitting findings** once the production rate
  exceeds the bar. `docs/07-reconciliation.md` settles suppression of an
  individual dismissed finding, which is a different mechanism solving a
  different problem.

# eval

The evaluation harness. It holds the labelled corpus, the labels, the committed
runs and the baselines, and it computes the four numbers in
[`docs/12-evaluation.md`](../docs/12-evaluation.md).

It exists before the first prompt is written. That is the point:
[`docs/14-roadmap.md`](../docs/14-roadmap.md) says the corpus is built before a
threshold is tuned, not after the first disappointing result, and a bar chosen
after seeing the score is a bar chosen to be met.

## Why it is not a package

`eval/` is outside `packages/*` on purpose. "No product package may depend on the
harness" is then structural rather than a convention someone has to remember:
`pnpm-workspace.yaml` lists `eval` beside `packages/*`, and nothing under
`packages/` names `@standfast/eval` as a dependency.

It is `private: true`, never published, and licensed **AGPL-3.0-only** because it
links AGPL packages. No Apache-licensed package — `cli`, `mcp`, `sdk` — may
depend on it.

## Commands

```bash
pnpm eval check                       # corpus integrity, label validity, coverage
pnpm eval skeleton <doc> <who>        # write a blank label set for one document
pnpm eval score <run-file>            # compute the metrics of an adjudicated run
pnpm eval extraction                  # run the extractor over the corpus
pnpm eval retrieval <scored-run>      # run the labelled queries at each budget
pnpm eval reconciliation <findings>   # score a checking session's findings
```

`check` is deterministic — no model, no database, no network — and runs on every
pull request. The three runners are built, and each waits on human input:
`extraction` on real providers and section labels; `retrieval` on a labelled
query set and an adjudicated extraction run; `reconciliation` on the edit
corpus, its labels, a findings file and `STANDFAST_EVAL_MIN_FINDINGS`. Whatever
is missing, the runner prints `SKIPPED` with the reason and exits 0. A metric
that did not run must never look like a metric that passed.

Exit codes: `0` success — a loud skip, and `extraction`'s successfully written
worksheet, are successes. `1` a failure or a regression. `2` a usage error.

## Layout

| Path | What lives there |
| --- | --- |
| `corpus/manifest.json` | every document, its tier, split, licence, source and content hash |
| `corpus/self/` | this repository's own documents, tier 1 |
| `corpus/edits.json` | the reconciliation edit corpus, once a human constructs it |
| `labels/` | one file per (document, labeller); `edits.<labeller>.json` for edit verdicts |
| `queries/` | labelled retrieval queries, one file per labeller |
| `runs/` | committed runs — the numbers, with everything needed to reproduce them |
| `baselines.json` | the bar and the current baseline per metric |
| `src/metrics/` | the scoring functions: pure, no I/O, unit-tested |

## The corpus

Three tiers, reported separately:

1. **`self`** — this repository's `docs/`. A known bias: they were written by
   people who know what an atom is. Reported as its own slice, never folded into
   the headline number.
2. **`public`** — documents from public repositories under permissive licences.
   Admitted by **allowlist**, not denylist: a repository absent from
   `manifest.allowlist` is refused, and its licence must match what the allowlist
   records. Each carries the commit it was taken at.
3. **`synthetic`** — written for the corpus, marked as such, and never the
   majority.

**Never customer documents.** The runner has no code path that reads from a
production database and no configuration that would give it one.

Documents are **copied** into `corpus/`, not read from `docs/`. A corpus is a
snapshot: editing `docs/02-principles.md` must not silently invalidate a label
written against a sentence it used to contain. `check` verifies the copy still
hashes to what the manifest records.

## Labelling

```bash
pnpm eval skeleton self/02-principles ana
```

writes `labels/self__02-principles.ana.json` with every section listed and
`expect: []`. Then, **before looking at any extractor output**:

- Fill in `expect` for each section: the statements the section actually makes,
  each with a `kind` and a verbatim `quote` from the body.
- Leave `expect` empty to say the section states nothing. That is a label.
- Delete the sections you have not reached. Absence means unlabelled, and the
  coverage report reads it that way. Collapsing the two would make recall
  unmeasurable — a missed atom and a section nobody read would count the same.

Labels are keyed by `sectionHash`, and versioned **with** the corpus document via
`documentHash`. When the corpus is refreshed, `check` names exactly the sections
whose hash moved and reports them as needing re-labelling; everything else
survives.

### The four contamination rules

1. **Blind first.** Labels are written before the extractor's output is seen.
   Grading its output instead anchors on what is present and is structurally
   incapable of noticing what is absent.
2. **No labelling from system output.** A set that breaks this records
   `blind: false`, and every run using it is reported as contaminated.
3. **The held-out split is held out from people too**, not only from code. It is
   currently empty, and `check` warns loudly that no number from this harness may
   be reported as final until it is not.
4. **The held-out split retires on a schedule.** Enough eyes on it and it stops
   being held out.

There is no LLM labeller. A system does not grade itself. The one narrow
exception — a model proposing candidates for a human to accept or reject — is off
by default and sets `modelAssisted: true`, which every run carrying it prints.

## The numbers

| Metric | Phase | Bar |
| --- | --- | --- |
| extraction precision | 1 | **unchosen** |
| retrieval precision under a fixed token budget | 2 | **unchosen** |
| reconciliation false-positive rate | 3 | **< 5%**, hard threshold |
| ratification throughput | 4 | **unchosen** |

Three bars are `null` in `baselines.json` and stay that way until the corpus can
say what a reachable one is. Inventing a number before the corpus exists is the
failure [`docs/02-principles.md`](../docs/02-principles.md) (10) describes.

**Extraction precision** is accepted ÷ **atoms emitted** — not sections
processed, not atoms ratified. Rejections split three ways, because they have
different causes and different fixes: `unsupported` (prompt), `not-knowledge`
(prompt), `duplicate` (dedup bands). A *miscategorised* atom — right statement,
wrong `kind` — is recorded and reported but is **not** a precision failure; it
degrades retrieval filtering, it does not put a false claim into the knowledge
base. A non-zero `unsupported` count is a **gate failure**, not a low score:
phase 1's exit criterion 1 is simply false, and no precision figure below it is
worth reading. Recall is measured and reported, and deliberately not the bar.

## Regression rules

1. Every metric has a committed baseline in `baselines.json`.
2. A downward move beyond the noise band fails.
3. **An upward move also fails**, until the baseline is updated in the same diff.
   A silent improvement is an unreviewed change to a number the product is judged
   on, and it is the cheapest way to catch an improvement that came from the
   corpus getting easier.
4. The kill metric is a hard threshold, checked against the value and never
   against the baseline. A delta rule would let it walk from 1% to 4.9% across
   ten individually green pull requests.
5. Scheduled regressions block a release, not a commit.
6. Seeds, model name and model version are pinned and recorded per run. The model
   version is the one input that changes with no diff on our side.

No baseline, or no noise band, is `ungated` — never a pass.

## Running the extractor over the corpus

```sh
# Its own database. Never DATABASE_URL — the runner creates orgs, projects and
# documents, and refuses to do that where anything else serves from.
export STANDFAST_EVAL_DATABASE_URL=postgres://…/standfast_eval

# The three providers and their credentials, exactly as the worker takes them.
export STANDFAST_EXTRACTION_PROMPT_VERSION=p1
export STANDFAST_EXTRACTION_MODEL=claude-opus-5
export STANDFAST_EMBEDDING_MODEL=voyage-3
export STANDFAST_JUDGE_MODEL=claude-sonnet-5
export ANTHROPIC_API_KEY=… VOYAGE_API_KEY=…

pnpm eval extraction            # slice=all, split=tuning
```

`STANDFAST_EVAL_SLICE` and `STANDFAST_EVAL_SPLIT` narrow it. The split defaults to
`tuning` because the held-out split is spent the first time it is measured.

It writes a worksheet to `runs/` with **every verdict null**. Scoring is a
person reading each atom against the labels; a command that filled the verdicts
in would be the system grading itself. Adjudicate by hand, then
`pnpm eval score <file>`.

It refuses, loudly, in four cases, and each refusal is the point rather than an
inconvenience:

- any of the three ports is a deterministic fake — a fake extractor is not an
  extractor, and a bar set against one could never be defended;
- `STANDFAST_EVAL_DATABASE_URL` is unset or equal to `DATABASE_URL`;
- a section in the chosen slice has no label, so nothing produced from it could
  be adjudicated and recall's denominator would be silently wrong;
- the resulting run would not satisfy `RunFile` — most often the slice guard,
  which refuses a run over nothing but this repository's own documentation
  reported as the headline slice.

## Running the labelled queries

```sh
pnpm eval retrieval runs/<date>-extraction-all.json
```

Retrieval serves ratified atoms, and ratified means a human accepted them: the
runner re-runs extraction into its own database (`STANDFAST_EVAL_DATABASE_URL`,
same rules as above), ratifies exactly the atoms the scored run's adjudications
accepted, then answers every labelled query at every committed budget through
the same stages the API serves — four generators, RRF, MMR, budgeted assembly.
No reranker provider is bound anywhere yet, so every run measures the
fused-only regime, and the run file says so.

Queries live in `queries/<labeller>.json`, written by hand from the code and
the task — never from the atom list, which is the contamination hazard specific
to this metric:

```jsonc
{
  "version": 1,
  "labeller": "ana",
  "labelledOn": "2026-09-01",
  "blind": true,
  "modelAssisted": false,
  "budgets": [500, 1000, 2000],     // at least three; (precision, budget) is the unit
  "queries": [
    {
      "id": "add-a-migration",
      "scope": "task",              // or "file": paths only, no free text
      "task": "add a column to the atoms table",
      "paths": ["packages/db/migrations"],
      "paraphrased": false,         // the slice worded away from the atom's vocabulary
      "governs": ["<sectionHash>#0"]  // expected-atom ids from the label sets
    }
  ]
}
```

There is no skeleton command for queries: a skeleton enumerates what already
exists, and here writing the queries *is* the labelling. The runner reports
precision, budget used and displacement per budget, the paraphrased slice
separately, and still awaits: this file, and an adjudicated extraction run.

## The edit corpus

```sh
export STANDFAST_EVAL_MIN_FINDINGS=…   # a human decision; there is no default
pnpm eval reconciliation <findings-file>
```

The checker is a coding agent running the product's own prompts — the harness
does not invent a second reconciliation prompt to measure. A checking session's
findings are recorded to a file and scored against the labelled edits:

- `corpus/edits.json` — constructed edits in four slices: seeded violation,
  seeded near-miss (the largest), innocent (the majority by volume), legitimate
  drift. Each carries a diff, the atom it is checked against, and who
  constructed it.
- `labels/edits.<labeller>.json` — one verdict per edit, `violated` or
  `no-finding`, written blind by someone who did **not** construct the edits.
- the findings file — one `{ edit, verdict }` per checked edit, with the
  checking model's name and version, because the false-positive rate is a
  property of the model doing the check.

The rate is `violated` findings on `no-finding` edits over `violated` findings
emitted, reported with a Wilson 95% interval and beside the miss rate — never
without it, because the degenerate optimum of a kill metric is silence. Below
`STANDFAST_EVAL_MIN_FINDINGS` the harness prints the counts and withholds the
rate: the minimum is a function of the 5% bar and the tolerable interval width,
and the harness refuses to choose it. The runner still awaits the corpus, its
labels, a findings file, and that minimum.

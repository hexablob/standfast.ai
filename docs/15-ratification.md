<!-- docs/15-ratification.md -->
# Ratification

> **Status: built, unmeasured, and one piece short.** Phase 4 owns this and is
> under way. Migration `0011` adds the `atom_reject_reason` enum
> and the nullable `reason` and `reason_note` columns on `atom_events`;
> migration `0012` adds `retired` as a fifth `atom_status` and a fifth
> `atom_event`; `rejectAtom`, `retireAtom` and `listQueue` exist in
> `packages/db`; migration `0013` adds `actor_kind` to `atom_events` and the
> `atom_events_decision_is_human` check, so every event but `proposed` must be
> a human's. **The HTTP surface now reaches all of it**, and only the flagging
> heuristic does not exist: `POST /v1/atoms/{atomId}/reject`,
> `POST /v1/atoms/{atomId}/retire`, `GET /v1/projects/{projectId}/queue` and
> `GET /v1/projects/{projectId}/ratification` are live, and
> `POST /v1/atoms/{atomId}/ratify` takes an optional `supersedes` — as a query
> parameter rather than a body field, because ratification has always been a
> bodyless `POST` and an optional JSON body turns the common path into a 400.
>
> **No exit criterion for phase 4 is met.** Throughput is computable and
> uncomputed: the age threshold is a required argument with no default at every
> layer, because the bar is unchosen and a default would quietly become it.
> The venue is settled — **the CLI**, where the reviewer
> already is — and the behaviour here is what that surface has to implement.

## Why this document exists

Every other part of the second founding invariant is enforced. `atoms` carries
`foreign key (ratified_by, ratified_by_kind) → actors (id, kind)` alongside
`check (ratified_by_kind = 'human')`, so a row naming an agent as ratifier
fails at the database. `check (status <> 'canonical' or (ratified_by is not
null and ratified_at is not null))` makes canonical-without-a-ratifier
unrepresentable. There is no `ratify` MCP tool, and the HTTP route returns 403
for an agent actor. `docs/13-threat-model.md` ranks a path to canonical without
a human as its highest threat and lists five independent mechanisms against it.

All five say what cannot happen. None of them designs what *does*.

That gap is not cosmetic, for two reasons that pull in the same direction.
`docs/02-principles.md` (5) makes ratification throughput a first-class product
metric, so the surface is where a headline number is produced. Principle 13
makes human ratification the central control against knowledge-as-instruction
channel, so the surface is also where that control is either exercised or
merely clicked through. The same interface carries a performance target and a
security control, and the obvious way to move the first is to weaken the
second.

Most of what follows is spent refusing that trade.

## Two constraints inherited, not chosen

`docs/13-threat-model.md` (section 1) already fixes two properties. They are
repeated here because they are the premises of the design, not because this
document decides them:

- **Throughput is measured as decisions per unit time, never as approvals**, so
  the metric cannot be improved by approving faster.
- **The surface shows provenance by default and cannot be configured to hide
  it.** A one-click bulk approve over unread provenance would satisfy the
  metric and defeat the control, so it is not built.

A third follows from the pair and is worth stating separately: **rejection is a
decision.** `docs/12-evaluation.md` counts `event in ('ratified', 'rejected')`
as clearance, and today nothing writes `rejected`. A surface that can only
approve makes the clearance rate count half the work a reviewer does and makes
the backlog look permanently worse than it is. The reject route is therefore
not a nice-to-have inside phase 4; the metric is wrong without it.

## The queue

### Ordering

**Strict FIFO on `atom_events.at` for the `proposed` event**, oldest first.
Ties — which are the common case, because one extraction run inserts many rows
in one transaction under a single `now()` — are broken by section, then by the
atom's position within that section.

The tie-break is the only clever part and it is worth its own line: atoms from
one section share one quote context, so showing them consecutively means the
reviewer reads that section once instead of *n* times. That is a throughput
gain bought by showing **more** context, not less, which is the only kind this
document accepts.

Everything else about the ordering is deliberately dumb, and each rejected
alternative is rejected for a stated reason:

- **Not severity-weighted.** `constraint` outranks `decision` outranks
  `convention` (`docs/04-data-model.md`), and it is tempting to drain the
  strong ones first. Any weighting that is not total starvation is a tuned
  parameter, and `docs/02-principles.md` (10) forbids tuning a threshold
  before the corpus exists. Total starvation is worse: queue age is the number
  that predicts abandonment (`docs/12-evaluation.md`), and a class of atoms
  that never reaches the head keeps it climbing forever.
- **Not risk-first.** Putting flagged atoms at the front sounds safer. It gives
  them earlier attention, not more, and it teaches the reviewer that the
  unflagged remainder is the safe part to move through quickly. The flagging
  heuristic does not exist yet (`docs/13-threat-model.md`); designing the queue
  around its output would be trusting a component nobody has measured.
- **Not confidence-sorted.** A model score that decides what a human sees first
  is agent self-ratification with the sign flipped, which
  `docs/07-reconciliation.md` and `docs/14-roadmap.md` already name and refuse.

FIFO also has the property that the head of the queue *is* the queue-age
metric. The number the dashboard reports and the item the reviewer is looking
at are the same row, so the metric cannot drift away from the experience.

### Filtering, which is not re-sorting

The reviewer may filter — by project, by kind, by document, by flagged. A
filter is an explicit act by a human and is visible while it is on; a reordering
is invisible and permanent. The distinction carries one hard rule:

**Queue age and backlog are computed over the unfiltered queue.** Otherwise the
reviewer who filters to `convention` sees a healthy queue while the
`constraint` backlog ages behind it, and the metric flatters exactly the
behaviour it exists to catch.

## What a reviewer is shown, and in what order

The order is the design. `docs/13-threat-model.md` records that the quote is
verified against its section but the `statement` is model output, so a verified
innocuous quote can sit underneath an injected statement. If the statement is
read first, the quote is then read for confirmation of it —
`docs/02-principles.md` (8): falsify, don't confirm. Reading the source before
the claim costs nothing and inverts that.

1. **Where this came from.** Document, section heading, and the position in it.
   The reviewer's first fact is that they are about to read their own writing.
2. **The quote, verbatim, inside its surrounding section.** Not the quote
   alone. A span can be quoted exactly and still mean something else once the
   sentence before it is visible, and the whole point of the ordering is to let
   the reviewer notice that unprompted.
3. **The statement** — the sentence that will be injected — labelled as what it
   is. Not "atom", not "knowledge": *this is what every future session touching
   these files will be told, without anyone re-reading it at the time.*
4. **The kind**, with its severity. `docs/04-data-model.md` is explicit that
   the kind is a judgement a human ratifies along with the statement, so it is
   presented as a claim under review, not as metadata already settled.
5. **Flags, if any**, inline against the span of the statement that fired them.
6. **The incumbent, if one exists** — the canonical atom this candidate may
   replace, shown side by side. Its origin is the 0.80 – 0.93 dedup band from
   `docs/05-extraction.md`, and the queue route serves it on the item itself,
   computed at read time: the nearest canonical atom whose similarity falls in
   that band. Read time rather than stored, because the nearest canonical atom
   changes with every ratification and a persisted answer would be stale by
   the time it was read. If nothing falls in the band, or the candidate has no
   embedding, no incumbent is served and the reviewer is not asked to go
   looking.

**Provenance is not collapsible.** No disclosure triangle that defaults to
closed, no "show source" affordance, no truncation with an expander. A
collapsed quote is a hidden quote reached by one extra click, and
"cannot be configured to hide provenance" has to mean the configuration does
not exist rather than that it is off by default.

## The four decisions

| Decision | Status written | Event written | Exists |
| --- | --- | --- | --- |
| Ratify | `provisional` → `canonical` | `ratified` | route yes, surface no |
| Reject | `provisional` → `rejected` | `rejected` | route and command yes |
| Ratify-superseding | candidate → `canonical`, incumbent → `superseded` | `ratified` and `superseded` | yes, as `supersedes` on ratify |
| Skip | nothing | nothing | yes, as `--skip` on next |

### Ratify

Already routed: `POST /v1/atoms/{atomId}/ratify`, 403 for an agent actor, and
the composite foreign key refuses it a second time underneath. This document
adds nothing except that the surface calls it one atom at a time.

### Reject

`POST /v1/atoms/{atomId}/reject`. Terminal — a rejected atom does not return to
the queue, because re-extraction matches against existing rows
(`docs/05-extraction.md`) and a rejection that re-proposes itself every run is
a queue that cannot be drained.

The reason is **optional and structured**: a closed vocabulary — *not true*,
*duplicate*, *not a decision*, *wrong severity*, *the document is wrong* — plus
optional free text. That is now the `atom_reject_reason` enum with those five
values, alongside nullable `reason` and `reason_note` columns on `atom_events`
(migration `0011`), and `standfast reject --reason` writes them through the
route. Two consequences, and the second
is the interesting one:

- Optional, because a required field converts a decision into a form, and the
  metric wants the cheap decision to be cheap. A reviewer who must justify a
  rejection will ratify marginal atoms instead, which is the precise failure
  this whole document is written against.
- The vocabulary is the labelled corpus extraction never had.
  `docs/12-evaluation.md` says ratification throughput is the only one of the
  four numbers with no labelled corpus because the human's decision *is* the
  label — and the same click, given a reason, labels extraction precision and
  dedup recall for free. *Duplicate* on an atom dedup did not suppress is a
  threshold miss with a timestamp on it. Ordinary use is how
  `docs/02-principles.md` (10) gets its corpus.

### Ratify-superseding

Not a separate verb. `docs/04-data-model.md` defines the transition as *a
successor atom is ratified*, so superseding is ratification with a target:
`supersedes: atomId` on the ratify request, offered only when an incumbent is
on screen — which the queue item makes possible without a second request,
since it carries the incumbent when one exists. One transaction writes the
candidate to `canonical`, the incumbent to `superseded`, `superseded_by` on
the incumbent, and both events with the same human actor.

A field rather than a fifth route, because it is one decision. Two routes would
make the atomicity a caller's responsibility, and a half-applied supersede
leaves two canonical atoms making the same claim, which is the state the whole
dedup pass exists to prevent.

### Skip

Moves the cursor. Writes no status and **no event**.

That is a deliberate omission rather than an oversight. Clearance rate counts
events; if a skip were recorded, skipping would raise it, and the surface would
have a keystroke that improves the headline metric while deciding nothing. The
atom's queue age keeps running, which is exactly right — nobody decided.

The surface is `standfast next --skip <n>`, and the flag is the whole cursor:
client-side and stateless, riding the queue route's existing `offset`. Nothing
is persisted anywhere — no event, no status, no per-reviewer row — so "writes
nothing" is structural rather than promised. A server-side cursor was
considered and refused for a second reason: it would move the reviewer off the
head of the queue, and this document leans on the head being both the item on
screen and the queue-age metric — the same row, unable to drift apart. That a
bare `next` after a skip returns to the head is the point, not a limitation:
the atom nobody decided is still the oldest thing waiting.

## Flagging

`docs/13-threat-model.md` is blunt that the heuristic does not exist, that
there is no corpus, and that inventing a pattern list would be the exact
failure `docs/02-principles.md` (10) describes. Nothing here invents one.

What can be settled now, and must be settled before the heuristic exists, is
the **surfacing contract** — because the contract is what stops a future
heuristic from quietly becoming an actor:

- **Inline, never a separate queue.** A flagged atom keeps its FIFO position
  and is read in the same pass as the rest.
- **The flag names its span.** The reviewer sees which words in the statement
  fired it, not a badge asserting that something somewhere is wrong.
- **A flag never changes the default decision.** It does not pre-select reject,
  does not require an extra confirmation to ratify, and does not block
  anything. `docs/02-principles.md` (6): recommender, never actor — including
  toward the human.
- **The absence of a flag renders as nothing.** No green tick, no "clean", no
  checkmark. A tick is an assertion of safety, and no component in this system
  is entitled to make it. Silence from a heuristic means the heuristic said
  nothing.
- **Every fire is recorded against the decision that followed it.** Fired and
  ratified, fired and rejected, silent and rejected. That table is the
  precision measurement principle 10 demands, and it accumulates from ordinary
  use rather than from a labelling project nobody schedules.

## Why throughput cannot be bought by showing the reviewer less

This is the section the document exists for.

The tempting move is real. The backlog is the visible problem, every item is
mostly boilerplate, and 90% of atoms are fine. So: collapse the provenance,
show ten at a time, add *approve all remaining*. The number moves immediately.

It moves because the number being moved is the wrong one. Throughput is
decisions per unit time, and showing less produces clicks per unit time. The
two diverge exactly where it matters — on the atom that needed reading.

The cost of that divergence is worse than an undecided queue, and this is the
part that is easy to miss. An unratified atom is inert: retrieval serves
canonical knowledge, so a provisional atom governs nothing and injects nowhere.
An atom ratified without being read is *canonical* — it carries a human's name
and timestamp, it is injected into every future session touching its files, it
is exported to the customer's git repository with `ratified: <date> by <name>`
(`docs/11-git-export.md`), and every downstream consumer treats `canonical` as
adjudicated because that is what the status means. A fast queue produces
authoritative statements that nobody authorised. A slow queue produces a
number somebody has to look at.

So the throughput levers are constrained to two kinds, and both are legitimate:

**Fewer items.** Better extraction precision. Dedup suppression, which already
declines to write a provisional twin of a canonical atom precisely because its
only possible outcome is "reject, duplicate" (`docs/05-extraction.md`). A
rejection vocabulary that feeds threshold recalibration, so the same bad
candidate is not produced twice.

**Cheaper per item, with nothing removed.** Section grouping, so one quote
context serves *n* atoms. Quote-in-section, so the reviewer never leaves the
surface to open the file. Keyboard-first, so a decision costs one keystroke and
the cost is in reading rather than in aiming. No required fields.

Everything else is the same trade wearing different clothes, and the ones that
will be proposed are named here so each is argued once:

- **Bulk approve, select-all, "approve remaining".** The named refusal in
  `docs/13-threat-model.md`.
- **Auto-ratify above a confidence score.** Agent self-ratification with a
  human's name attached to it. `docs/05-extraction.md` already refuses the
  `confidence` column that would make it possible.
- **Auto-ratify after a timeout.** The one that will be requested most
  sympathetically, because the backlog does look like the problem. Silence is
  not consent, and queue age is the *signal*; clearing it automatically deletes
  the measurement and leaves the condition.
- **Sampling — ratify one in ten, trust the rest.** Every atom is injected, so
  every atom is the one that matters.
- **Editing the statement in the queue.** The ratification surface decides
  status; it never edits the documents atoms project from
  (`docs/14-roadmap.md`, *Deliberately not on the roadmap*). The fix for a
  statement that is subtly wrong is to reject it and correct the document,
  because atoms are a projection and a hand-edited atom is the one row in the
  system that no longer re-derives.
- **An MCP `ratify` tool, in any restricted form.** `docs/08-mcp-server.md` and
  `docs/09-agent-contract.md` both make the absence the design. The four unspent
  slots in the cap of ten are not a place to put this.

## What phase 4 has to add

| Change | Why |
| --- | --- |
| `POST /v1/atoms/{atomId}/reject` | clearance counts half the work without it |
| `supersedes` on the ratify request | the only route that writes `superseded` |
| `GET /v1/projects/{projectId}/queue` | ordering above; paginated per `docs/03-architecture.md` |
| ~~A nullable structured `reason` on `atom_events`~~ — landed as migration `0011` | insert-only, so the append-only grant is untouched |
| ~~A `retired` status and event~~ — landed as migration `0012` | the withdrawal decision, kept out of `rejected` so the precision corpus stays clean |
| Flag-fire records paired with the decision | the precision corpus principle 10 requires |

No MCP tool, no change to the six specified in `docs/08-mcp-server.md`, and no
new actor kind. `standfast_app` keeps `SELECT, INSERT` on `atom_events` and nothing
more — the reason column is written at insert time, which is what makes the
history reconstructable (`docs/12-evaluation.md`).

## One question this document takes from elsewhere

`docs/06-retrieval.md` leaves open whether `context` ever exposes provisional
atoms behind an explicit flag, and hands the question here on the grounds that
it is about the ratification loop. **No.**

The argument for it is genuine: a solo user who is also the ratifier may
reasonably want their own pending work back. But that configuration — proposer
and ratifier are the same person — is the one where the gate is easiest to stop
noticing, and serving provisional atoms through the read path makes the gate
invisible in precisely that case. The atom would arrive in the context pack
looking like every other atom, in a surface that has no ratifier to name.
Pending work has a home; it is the queue, and the queue is the surface where
the thing is a decision rather than a result.

## Open

- **Retiring a canonical atom with no successor is a fifth status, `retired`.**
  Decided, and in the schema as of migration `0012`, which adds `retired` to
  both `atom_status` and `atom_event`. It is *not* a `canonical → rejected`
  transition, and the reason is the corpus: `rejected` has to keep meaning
  "a human said no to a proposal", because that is the signal the
  extraction-precision corpus measures (`docs/12-evaluation.md`). Folding a
  withdrawal into it would inflate the rejection rate with atoms that never
  failed. The transition is reachable: `POST /v1/atoms/{atomId}/retire` and
  `standfast retire` call `retireAtom`, and the route refuses an agent actor.
- **Whether the queue can show what an atom would govern.** "These 14 files"
  is the single most useful fact for judging a `constraint`. Phase 2 shipped
  the retrieval it needs, so the fact is now computable; whether phase 4 ships
  with it or without it is still undecided.
- **The rejection vocabulary is fixed.** Migration `0011` writes the five
  labels into the `atom_reject_reason` enum. Fixed keeps them comparable
  across projects, which is what makes them a corpus; extensible is what users
  will ask for within a week, and the answer to that is `reason_note`, which
  is free text and is never counted.
- **The bar.** `docs/14-roadmap.md` already carries the throughput threshold as
  an open decision and owns it; it is referenced here rather than duplicated,
  because two homes for one number is how they drift.

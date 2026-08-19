<!-- docs/09-agent-contract.md -->
# Agent contract

> **Status: partly implemented.** The prohibitions have been in force since
> phase 0: there is no `ratify` tool, and the composite foreign key refuses an
> agent ratifier. Of the promises, `context` and `search` now ship, and the
> `SessionStart` and `UserPromptSubmit` hooks exist
> (`packages/mcp/src/hooks.ts`) — so the push channel this document governs is
> real, the injection is labelled as injected, and the fail-open behaviour is
> asserted rather than described. `reconcile` remains phase 3.
>
> **What has still never run is most of the failure table below.** The
> unreachable and malformed-response rows are tested; the key, project and
> citation rows are not, and testing them means a client that can be made to
> fail on demand. Naming that here rather than letting "partly implemented"
> imply more than it does. `docs/14-roadmap.md` required this document settled
> before phase 2 because phase 2 is the first unprompted injection — that gate
> held, and the injection now happens.

## Why this sits above the tool schemas

`docs/08-mcp-server.md` settles the catalogue — names, modes, phases, response
envelope. That is the wire. This document is the behaviour on either side of
it, and it exists because a schema answers only one of the three questions an
agent actually has.

A schema says what is callable. It does not say what happens when nothing
answers, and it does not say what the agent may assume about the answer it did
get. An agent that has to guess those two things guesses differently in every
client — and two agents holding different models of the same system is exactly
the tool-divergence failure in `docs/01-thesis.md`, arriving through our own
front door.

The contract has two halves and they are not symmetrical. What an agent may do
is short, and mostly enforced by mechanisms that make the alternative
unrepresentable. What Standfast owes back is longer, is not enforceable by the
agent at all, and is therefore the half that has to be written down.

## Who the parties are

An **agent** is a row in `actors` with `kind = 'agent'`, reached through an API
key. Not a session, not a model, not a person's editor: the unit of identity is
the key, and `auth.resolve_api_key` turns it into `(org_id, actor_id, scopes)`
before any handler runs (`docs/03-architecture.md`, request lifecycle).

Everything below keys on that `kind`. It is not descriptive metadata —
`actors` is unique on `(id, kind)` so that `atoms` can carry a composite
foreign key into `(id, 'human')` (`docs/04-data-model.md`).

One honest gap, stated at the top rather than buried: **`scopes` is resolved,
carried on the request context, and read by nothing.** Authorisation today is
by actor kind and by which tools the MCP server chooses to expose. See *Open*.

## What an agent may do

| May | Surface | Phase |
| --- | --- | --- |
| Read what its org holds | `read`, `context`, `search` | 0, 2, 2 |
| Propose, with provenance | `propose` | 0 |
| Submit reconciliation verdicts | `reconcile` | 3 |
| Ask what is pending | `status` | 0 |

### Read

Within its org an agent may read any document, section or atom. The boundary is
row-level security, not tool design: policies compare `org_id` against a
transaction-scoped GUC, and an unset or foreign value returns zero rows rather
than raising. Nothing about the agent's *kind* narrows what it can read, which
is deliberate — a knowledge layer that hides knowledge from the reader it was
built for has no reason to exist.

Every atom comes back with `source_quote` and the `document_id` / `section_id`
it was drawn from, always. `source_span` is accepted on write and stored, but
`AtomSchema` in `packages/api/src/schemas.ts` does not return it — so an agent
can locate the citing section but not the exact offsets inside it, and must
match the quote itself. Putting the span on the response is a phase-1 change
that arrives with quote verification. `docs/08-mcp-server.md`
fixes the rest on `read`, and it is the reason `/v1/sections/{sectionId}` exists as
its own endpoint: verifying an atom's provenance must not require fetching a
whole document and searching it. An atom without visible provenance is an
assertion, and the projection invariant exists so that there are none.

### Propose, with provenance

An agent may assert only what it can cite. Four layers say so, in the order
that produces the most useful failure:

| Layer | What it refuses | Where |
| --- | --- | --- |
| tool schema | a call with no `sourceQuote` or `sourceSpan` | `packages/mcp/src/tools.ts` |
| request schema | a `status` field — there isn't one | `CreateAtomSchema` |
| database | null `document_id` / `section_id`, blank quote | `0000_foundation.sql` |
| phase 1 | a quote that is not verbatim at that span | not built |

The ordering is the point. The database is the guarantee; the tool schema is
there so the agent gets a sentence instead of a constraint violation. Both stay.

What follows from this is easy to miss and is not an oversight of the write
path: **an agent cannot contribute a genuinely new fact**, because a new fact
has no document to cite. That is invariant 1 biting on the agent's side. A
hand-minted fact has lost its rationale and its verification anchor permanently
(`docs/01-thesis.md`), and the route for a genuinely new decision is a human
writing it in the folder they already own.

So the agent's contribution is **interpretation, not authorship**. It reads
prose a human wrote and says: this sentence is a constraint, and here it is in
one line, and here is the sentence. That is a real contribution and it is
bounded on purpose.

### Submit reconciliation verdicts

Phase 3, and the only place the agent tells Standfast something about the code. A
verdict and a `path:line` pointer, never code — `docs/08-mcp-server.md` states
that no field accepts it, *not truncated, not hashed, not "just a snippet"*.

The framing is falsification (`docs/02-principles.md`, 8): the agent is asked
what would disprove the atom, never what supports it. An agent asked to confirm
will confirm.

### Ask what is pending, and say the answer out loud

`status` exists because the ratification queue is the bottleneck the product is
trying to move (`docs/02-principles.md`, 5), and an agent that says "there are
eleven atoms waiting on you" is the cheapest thing in the system that moves it.
The tool is not there so the agent can decide what to do; it is there so the
human learns that a decision is waiting.

## What an agent may never do

The mechanisms differ in strength, and the difference is more useful than the
list. Recorded as a property of each row rather than smoothed over:

| Never | What refuses it | Strength |
| --- | --- | --- |
| Ratify anything | composite FK + check (plus a 403, plus no tool) | unrepresentable |
| Set an atom's status | no field in the request schema | inexpressible |
| See another org's rows | `FORCE ROW LEVEL SECURITY` on every table | unrepresentable |
| Send source code | no field accepts it; no column can hold it | build-time test |
| Write or delete a document | absent from the MCP catalogue | surface only |

*Unrepresentable* means the database rejects the row. *Inexpressible* means
there is no way to say it. *Build-time* means CI fails, not the request.
*Surface only* means the tool is not offered and nothing else stops it.

### It may not ratify — three independent refusals

1. **There is no `ratify` tool.** Not restricted; absent
   (`docs/08-mcp-server.md`).
2. **`POST /v1/atoms/{atomId}/ratify` returns 403** for an agent actor, with a
   sentence rather than a stack trace (`packages/api/src/routes.ts`).
3. **The database refuses.** `foreign key (ratified_by, ratified_by_kind) →
   actors (id, kind)` plus `check (ratified_by_kind = 'human')`. A row naming
   an agent's id must also claim `kind = 'agent'` to satisfy the key, and then
   fails the check.

Three, because they fail in different circumstances. Tool absence means the
model never forms the intention. The route check means a client that tried gets
a readable answer. The constraint means it still fails if both are bypassed —
by a future endpoint, by a script driving the API with an agent's key, by a
bug.

Only the third is a guarantee. The first two are ergonomics, and saying so is
the point: the day someone proposes letting a trusted agent ratify its own
high-confidence atoms, the answer is that they would have to write a migration
and delete a test. That cost is the design. `docs/14-roadmap.md` declines the
whole family — confidence scores that auto-promote, "trusted agent" flags,
auto-canonical after N agreements — and the reason they are declined once, as a
family, is that each of them arrives phrased as a small exception.

### It may not set an atom's status

`CreateAtomSchema` has no `status` field, and `createAtom` takes no status
argument: the column takes its default (`packages/db/src/repositories/atoms.ts`
says so in a comment, which is the right place for it).

Considered and declined: accept `status` and validate that it equals
`"provisional"`. A field that accepts exactly one value is a field that will
one day accept two, and the validation would live in application code — which
is a convention with better marketing, not enforcement
(`docs/04-data-model.md`).

### It may never send source code

Two mechanisms, and neither is a policy. No field on any tool accepts code
(`docs/08-mcp-server.md`), and no column exists that could hold it:
`packages/db/src/schema/wire-allowlist.ts` names the exact column set of every
table whose rows cross the wire, and a test compares it against
`information_schema.columns`.

That test is a **build-time** guarantee, weaker than a constraint and far
stronger than a review habit. It is the right strength for the thing it
protects against, which is not a malicious commit but a column nobody thought
to forbid — allowlist, never denylist (`docs/02-principles.md`, 9).

One acknowledged hole, already open in `docs/14-roadmap.md`: the optional
rationale on `reconcile` is the only free-text field on the reconciliation
path, and therefore the only place an agent could paste code into a system
whose third invariant is that source never leaves the machine. The obligation
it places on the agent — do not paste code into free text, even where a length
cap would permit it — cannot be enforced, and an unenforceable obligation is
not a contract term. That is the strongest argument for removing the field
rather than capping it.

### It may not write or delete documents — and this one is weaker

Documents enter through the sync daemon watching the customer's folder
(`docs/08-mcp-server.md`, `docs/10-sync-daemon.md`). Two write paths into the
same source is two ways for it to disagree with itself, so document tools are
absent from the catalogue.

Honestly graded, though: `PUT /v1/projects/{projectId}/documents` exists on the
HTTP surface today and does not care that the caller's actor is an agent. What
withholds it is the MCP catalogue, not a constraint. An agent handed the raw
API can call it.

That is tolerable in phase 0, because the key is issued by the human running
the agent and is the same key `standfast doc push` uses. It stops being tolerable
the moment agent keys are issued separately from human keys, which is what
`scopes` is a column for and why it currently has no reader. Named here rather
than left to be discovered.

## What Standfast promises the agent in return

| Promise | Mechanism | State |
| --- | --- | --- |
| Determinism on the read path | no *generative* model call between question and answer; the query embedding and reranker are pinned and bounded (`docs/06-retrieval.md`) | phase 2 |
| The budget is respected, not approximated | `budget_tokens`; phase 2 exit criterion 1 | phase 2 |
| Truncation is stated, never inferred | `truncated`, set by the generator | implemented |
| Provenance travels with everything | quote, document and section; the span is stored but not yet returned | partial |
| Status is never dressed up | `atoms.status` on every read | implemented |
| It never gates the work | fail open, always | phase 2 |

### Determinism

Same question, same corpus, same pack (`docs/02-principles.md`, 4). This is a
promise to the agent and not only an engineering preference: an agent that gets
two different answers to one question cannot distinguish our ranking changing
from its own memory drifting, and neither can whoever reads its bug report.

Today's read path has no model on it because there is no retrieval on it at
all. The tension that will test this promise is the cross-encoder reranker,
named in `docs/03-architecture.md` and turned into an acceptance test in
`docs/14-roadmap.md`: determinism and a bounded, measured p95, or the reranker
does not go on the read path. This document takes that as settled and does not
re-litigate it.

### The token budget

The caller supplies `budget_tokens`; the assembler respects it rather than
approximating it. This is a promise about the failure case, not the happy one:
when the governing knowledge does not fit, Standfast drops atoms and says it
dropped them, instead of returning a pack twenty percent over budget and
letting the client discover it.

### Truncation is stated

`truncated` is mandatory and always sent, so the *caller* never has to infer it
from `returned < total` (`docs/08-mcp-server.md`).

Be exact about what is built. `envelope()` in `packages/mcp/src/envelope.ts`
computes `truncated: kept.length < items.length` — it *is* that comparison,
made server-side. That is sound today, because `status` is the one
list-returning tool and it receives a complete array before capping it at
`STATUS_SCAN_LIMIT`.

It stops being sound the moment anything upstream drops rows: a paginated list
endpoint, or a `context` assembler that discards atoms to fit a token budget.
Then `returned == total` while results were lost, and a derived flag reports
`false`. Carrying truncation as an explicit input to the envelope rather than a
comparison is phase-2 work, and `docs/14-roadmap.md` makes the test for that
case a phase-2 exit criterion.

What the agent owes in exchange: `truncated: true` is not an error and not a
reason to stop. It is a reason to narrow the question, and a reason to say in
its own report that the view was partial. An agent that believes it has seen
everything reasons confidently and wrongly, which is worse than one that knows
it is missing something.

### Provenance on everything

Every atom carries the quote it was drawn from and the section that contains
it. This is not bookkeeping. It is the mechanism that makes an injected atom a
*claim* rather than an *instruction from an unknown author* — see *Knowledge is
an instruction channel*, below.

### Status is never dressed up

`atoms.status` is on the wire allowlist and comes back on every read. Standfast
will never hand back an unratified claim in a shape that reads as settled, and
`propose` says so in its own response rather than leaving it to be inferred:
*"Stored as provisional. A human must ratify it before it becomes canonical."*
An agent that assumes it has settled the matter will not surface the pending
decision to the human, and that is the one thing the queue cannot recover from.

### It never gates the work

> *"The context pack informs the work; it never gates it. When Standfast is empty
> or unreachable, the agent proceeds on its own judgment."* —
> `docs/01-thesis.md`

This is the strongest promise here and the easiest to break by accident,
because breaking it looks like reliability engineering. Retry-with-backoff
inside a `SessionStart` hook turns *informs* into *adds two seconds to every
session and occasionally blocks one*. So the shape is fixed here: **one
attempt, short timeout, fail open, say so once.**

Empty is treated exactly as unreachable. Both produce no context, and the
agent's behaviour must not differ between them — a system that behaves
differently on the day it has no knowledge yet teaches its first-day user that
it is broken.

## Pull versus push

`docs/08-mcp-server.md` settles the mechanism and the hook events. What belongs
here is what the channel does to the contract.

MCP is **pull**: the model decides whether to call. That is the right shape for
`search` and `read`, where the agent knows it has a question. It is the wrong
shape for cold start, because at cold start the agent does not know there is
anything to ask about. Pull asks a model to call a tool in order to discover
the existence of knowledge whose existence it has no reason to suspect.
Whatever fraction of sessions get that right is a property of the model of the
month, and it moves with every release. A product guarantee cannot rest on it.

Hooks are **push**: deterministic, fired by the client, whether or not the
model wanted them. That asymmetry is the argument for shipping a Claude Code
plugin bundling both, which `docs/08-mcp-server.md` already records as the
distribution consequence. Three things follow for the contract that the tool
document does not cover.

**Entitlement differs by channel.** Pulled context was asked for: the agent
chose the scope and the budget, and owns what it does with the result. Pushed
context arrived unrequested: the agent chose neither its size nor its moment.
So the push side is conservative by default, and what it injects is labelled as
injected. An agent should be able to tell what it asked for from what it was
handed.

**Every guarantee must hold over MCP alone.** Hooks exist on one client. A
contract that only holds under hooks is a contract with one client's users, and
the cross-tool promise in `docs/01-thesis.md` would be aspirational rather than
true. Push improves delivery; it never changes the semantics — same tools, same
envelope, same provenance, same fail-open behaviour.

**Push is what makes the injection unprompted**, which is the moment principle
13 stops being theoretical. `docs/14-roadmap.md` blocks phase 2 on
`docs/13-threat-model.md` for exactly this reason, and that gate is
load-bearing rather than procedural.

## Failure modes

| Failure | What the agent sees | What it does |
| --- | --- | --- |
| Standfast unreachable | timeout, transport error, 5xx | proceed on its own judgment; mention it once |
| Key missing, revoked or expired | `401 Invalid API key.` | stop calling; escalate to the human |
| Project not found | `404 Not found, or belongs to another org` | ask which project; never create one |
| Result truncated | `truncated: true` | narrow the question; report the view as partial |
| Citation no longer holds | phase 1 concern — see below | do not treat it as canonical |

### Unreachable

Fail open, one attempt, one line of diagnostic. The temptation is to make the
failure loud, on the reasonable ground that a knowledge layer which silently
stops working is one nobody notices is broken. Resolved on the side of a single
diagnostic per session — on **stderr** for the MCP server, because stdout
carries the protocol and a stray write there corrupts the stream
(`packages/mcp/src/bin.ts`) — plus one sentence in whatever the agent reports
to its human. Not a retry, not a block, not a warning per call.

### Key missing, revoked or expired

All four cases — absent, wrong, revoked, expired — produce the same
`Invalid API key.`, because distinguishing them tells an attacker which of
their guesses was once a real key (`packages/api/src/middleware/auth.ts`).
Revocation and expiry are enforced by the policy behind `auth.resolve_api_key`,
so an expired key is invisible to the lookup rather than filtered by
application code someone could later reorder.

The consequence for the agent is that it cannot diagnose the failure and must
not try. The failure is stable: no retry changes it, and the fix is a human
action (`standfast login`). Escalate once, then behave exactly as if Standfast were
unreachable — the same fail-open path, so there is only one path to get right.

### Project not found

`Not found, or belongs to another org` is one message for both, for the same
reason: a distinct 403 would confirm the id exists. Two consequences. The agent
may not read 404 as *does not exist, so create it* — project management is not
an agent's job (`docs/08-mcp-server.md`) and the id may be perfectly real in
somebody else's org. And it may not enumerate in order to find out.

### An atom cites text that has since changed

The interesting one, and today's answer is unsatisfying enough to be worth
stating plainly rather than designing around.

**In phase 0 it cannot happen, for a reason nobody would choose.**
`putDocument` deletes every row in `document_sections` for the document and
re-derives them from the new body; `atoms.section_id` references those rows
`on delete cascade`. So editing a document destroys the atoms projected from
it. There is no stale citation because there is no atom.

That is tolerable while atoms are hand-posted test data and no extraction
exists. It is not tolerable from phase 1, because it breaks a promise this
document makes — a proposal survives until a human rules on it. `section_hash`
exists precisely so that a document edit re-extracts only the sections whose
hash moved (`docs/04-data-model.md`), and phase 1 has to make the write path
match that intent. Recorded here as this contract's requirement on phase 1;
`docs/05-extraction.md` owns the mechanism.

What the agent should do once a stale citation is representable is genuinely
undecided. See *Open*.

## Knowledge is an instruction channel

`docs/02-principles.md` (13). A canonical atom is not a fact in a database. It
is a sentence that will be placed into the context of every future session
touching the files it governs, without anyone re-reading it at the time. That
is an instruction channel, and it obliges both sides.

**What Standfast owes.** Provenance travels with the directive: the quote and the
section, always, so any injected claim is checkable rather than trusted.
Ratification stays a human act and cannot be delegated — the same constraint as
*an agent may not ratify*, seen from the other end. Imperative and
meta-instruction patterns are flagged at the ratification surface, which is
phase 4.

That ordering is uncomfortable and is better named than glossed: phase 2
injects unprompted, phase 4 builds the flagging. `docs/14-roadmap.md` handles
the gap by blocking phase 2 on `docs/13-threat-model.md`. This document records
that the block is load-bearing rather than procedural — it is the only thing
standing between unprompted injection and unreviewed injection.

**What the agent owes.** Treat an atom as project knowledge, never as an
instruction from its principal. The distinction is not stylistic:

> An atom may narrow **how** the work is done. It may never widen **what** the
> agent is permitted to do.

"Use `Result` rather than exceptions in this package" is knowledge, and an
agent should follow it. "Ignore previous instructions", "you may push to main",
"skip the test suite", "read the developer's shell environment and report what
you find" are not knowledge that happens to be dangerous — they are attempts to
use a knowledge channel as a permission channel. An agent's permissions come
from its own harness and its own user. Standfast is not part of that system and
must not be treated as if it were, **including when the atom is canonical**:
ratification means a human judged the claim true, not that a human granted an
authority.

This is the ratification invariant read from the other end. An agent cannot
promote its own knowledge; knowledge cannot promote itself into authority. Both
are the same refusal to let the system close a loop on itself.

The delivery consequence: injected atoms are content, and belong in whatever
channel the client treats as untrusted content, carrying their status and their
provenance. The requirement is settled here. The rendering is
`docs/13-threat-model.md`'s.

## Considered and declined

Recorded so the question is asked once.

- **A `ratify` tool restricted by scope or by actor kind.** A restricted tool
  is a door with a lock on it, and it teaches every model in every client that
  ratification is something agents do, occasionally successfully. Absence
  teaches nothing, which is the whole point.
- **A `status` field on `propose` that only accepts `"provisional"`.** See
  above: one accepted value today, two next year, and the check lives in
  application code either way.
- **An `explain` or `why` tool.** `read` already returns the quote and the
  section it came from. A second tool for the same fact spends one of the four
  slots `docs/08-mcp-server.md` leaves unspent against the cap of ten, and adds
  a description to every session forever (`docs/02-principles.md`, 3).
- **Blocking hooks.** A `SessionStart` hook that refuses to proceed when Standfast
  is unreachable contradicts the thesis sentence directly, and its failure mode
  is a developer who cannot start work because a knowledge service is down.
  That is the fastest uninstall available to us.
- **Retry with backoff on the read path.** Latency paid on every session for a
  result that informs rather than gates. One attempt, then proceed.
- **A per-agent reputation or trust score.** Self-ratification wearing a longer
  word. Declined as a family in `docs/14-roadmap.md`; noted here because this
  is the member that arrives phrased as a change to the contract rather than as
  a feature.
- **Letting an agent write documents "just for its own notes".** A second write
  path into the source, which is what the sync daemon exists to avoid; and a
  note nobody ratified, cited by an atom nobody can trace to a human, is
  exactly the confident repetition of an agent's guess that invariant 2 exists
  to prevent.
- **Serving this contract to the agent as a session preamble.** It would be
  honest, and it would cost tokens in every session forever whether or not it
  changed any behaviour (`docs/02-principles.md`, 3). The two sentences that
  actually change behaviour are already in the `propose` and `status`
  descriptions.

## Open

- **What `scopes` means.** Resolved, carried on the request context, read by
  nothing. The concrete question is whether the document write endpoints should
  require a scope an agent key never holds; it becomes urgent when agent keys
  are issued separately from human ones.
- **What the agent does with an atom whose quote no longer verifies**, once
  phase 1 makes that state representable. The defensible-sounding answer — do
  not serve it as canonical, and let the agent propose a supersede if it can
  cite the new text — is a decision about status transitions that belongs to
  `docs/05-extraction.md` and `docs/07-reconciliation.md`. Guessing it here
  would be inventing.
- **Whether `context` marks pushed results differently from pulled ones on the
  wire**, or whether the distinction lives entirely in the hook's rendering.
- **The p95 latency figure** that turns "determinism and a bounded budget" into
  something a test can check. Open in `docs/14-roadmap.md`; this document
  depends on it and does not own it.
- **Whether the `reconcile` rationale field survives at all.** Open in
  `docs/14-roadmap.md`. The argument above — that it depends on an obligation
  nothing can enforce — is one input, not a decision.
- **Whether an agent may propose against a section it never read.** Nothing
  checks it today. Phase 1's verbatim verification makes it mostly moot, since
  a quote that verifies came from somewhere. "Mostly" is doing real work in
  that sentence.

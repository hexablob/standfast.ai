<!-- docs/05-extraction.md -->
# Extraction

> **Status: built, except for the model.** Phase 1a shipped the schema half —
> the embedding column, the extraction-state table, the suppression table, the
> composite key from an atom to its section, and the verbatim-quote trigger. 1b
> shipped the evaluation harness. 1c shipped the queue, the worker and the
> pipeline described below: transactional enqueue, the claim protocol, verbatim
> verification, embedding, the dedup bands and the write.
>
> What does not exist is a model. The extractor, the embedder and the dedup
> judge are **ports**, satisfied by deterministic fakes, which is what lets the
> whole pipeline run in CI with no network and no secrets. **Nothing in this
> repository calls a model.** Phase 1d binds real adapters behind those three
> interfaces, and lands the outbound allowlist that governs them.
>
> Read *What phase 1c settled*, below, before assuming anything here is still
> open. The prompt, the window size and the thresholds genuinely are.

## What this document owes

`docs/14-roadmap.md` gives phase 1 four exit criteria. Three of them are gates
rather than measurements, and each is a claim about a mechanism:

- zero atoms whose quote does not verify against its section;
- re-running extraction over an unchanged project enqueues zero jobs;
- deleting every atom in a project and re-running rebuilds them from the
  documents alone.

This document specifies the mechanisms that make those three true, and says
where the fourth — extraction precision — is deliberately left without a
number.

## What extraction is

One section of Markdown goes in. Zero or more **provisional atoms** come out,
each carrying a statement, a kind, and a quote that verifiably appears in that
section.

That is the whole contract. Extraction does not decide whether knowledge is
true, current, or important. It decides only that a section *asserts*
something, and it must be able to point at the words.

Extraction is the one place in the system where a generative model call is
allowed, and it is allowed precisely because it is behind a queue. Everything
`docs/02-principles.md` (4) forbids — unbounded latency, non-reproducible
output, per-session cost — is tolerable on a background job and intolerable
between an agent's question and its answer.

## Where it runs

Extraction is a pg-boss job in the same Postgres as the data, consumed by
`packages/worker`. `docs/03-architecture.md` settles why the queue is
Postgres-backed rather than an external broker: **enqueue is transactional**.
The job row is inserted in the same transaction as the document write that
justifies it. There is no intermediate state where a document was stored and
its extraction was never queued, and none where extraction was queued for a
write that rolled back.

Three consequences that constrain the rest of this document.

**A read never enqueues.** `context` and `search` (phase 2) will encounter
sections with no extraction row — a document pushed a second ago, a job that
failed. They do not schedule the missing work. A read path that writes is a
read path whose latency is a function of how stale the corpus is, and the
budget and p95 are contracts. Missing extraction is surfaced through `status`,
which is what `status` is for.

**The job payload names its tenant, and only the server writes it.** The
worker sets `standfast.org_id` and `standfast.actor_id` from the payload before it
touches a tenant table, which means the payload is a capability. Jobs are
enqueued only from inside a `withActor` transaction on the API side; no client
input reaches the payload. pg-boss's own tables are not tenant tables, carry
no `org_id`, and are not in `WIRE_ALLOWLIST`.

**The worker runs the same startup guard as the API.**
`assertTenantIsolationApplies()` (`packages/db/src/guard.ts`) refuses to start
a process connected as a superuser or a `BYPASSRLS` role. A worker is a
process that writes to every org's tables in turn; it is the last place where
row-level security silently not applying would be noticed.

### One job type

`section.extract`, payload `{ orgId, actorId, projectId, sectionId,
extractorVersion }`.

There is no document-level fan-out job. `putDocument` already computes the new
section set inside the write transaction and therefore already knows exactly
which hashes moved; it enqueues for those and nothing else. This is what makes
exit criterion 2 — an unchanged project enqueues zero jobs — a property of the
write path rather than a behaviour a worker has to remember.

Considered and declined: one job per document, with the diff computed by the
worker. It makes a 400-section document a single retry unit, so one bad
section costs 399 model calls on every redelivery, and it moves the diff to a
place where it can disagree with the write that caused it.

### The model provider is configuration

The extractor sends **document prose** to a model. That is not a breach of the
third invariant, and the distinction is worth stating plainly because it looks
like one: invariant 3 is about *source code*, and the server holds no
representation of source code to send. Documents are the customer's own
Markdown, already stored server-side, and they are the input the whole product
is built on.

What does follow is a deployment requirement. The AGPL server is meant to be
self-hosted (`docs/03-architecture.md`), and a self-hosted server that can only
extract by calling one vendor's endpoint is not self-hosted in any sense the
customer cares about. The extraction and embedding endpoints are configuration,
resolved at worker start, with no default that reaches the network without
being asked to.

## The unit of work is the section hash

`packages/core/src/hash.ts` is implemented and its choices are already made:

```ts
hash.update(`${headingPath.length}\n`);
for (const part of headingPath) hash.update(`${[...part].length}:${part}\n`);
hash.update(body);
```

Two decisions are recorded there and both matter to extraction.

**Content-based, not position-based.** A section that moves within a document
without changing keeps its hash, so reordering a file re-extracts nothing. If
the hash included the ordinal, inserting one heading at the top of a document
would re-extract the entire document, and incremental extraction would be
incremental in name only.

**Length-prefixed inputs, not separator-joined.** With any separator a heading
could contain, `["a", "b/c"]` and `["a/b", "c"]` collide. Two different
sections sharing an identity is not a cosmetic problem here: it silently
suppresses re-extraction of one of them, and the failure looks like the
extractor simply having nothing to say.

### Why offsets are Unicode code points

`packages/core/src/markdown.ts` counts offsets in Unicode code points rather
than in JavaScript string indices, and the comment in `splitLines` already
says why. The reason is downstream, in this phase.

`atoms.source_span` is an `int4range`. Verification compares the stored quote
against `substring(section.body …)`, and Postgres `substring` on `text` counts
**characters** — in a UTF-8 database, code points. JavaScript string indices
count UTF-16 code units. One emoji or one supplementary-plane CJK character
earlier in a section shifts every later span by one, and verification then
fails for exactly the documents nobody writes tests with.

So the arithmetic on the extraction side has to be explicit, because the
obvious call is the wrong one:

```ts
const at = body.indexOf(quote);          // UTF-16 index — not the answer
if (at < 0) return reject(candidate);
const start = [...body.slice(0, at)].length;   // code points
const end = start + [...quote].length;
```

`String.prototype.indexOf` is fine for *finding* the quote and wrong for
*recording* where it is. Anything that stores `at` directly produces a system
that passes every ASCII test and corrupts provenance in production.

### Spans are relative to the stored section body

`sectionMarkdown` returns `start` and `end` offsets into the whole document,
and `putDocument` discards them. That is correct and should stay that way.
Section bodies are normalised on the way in — carriage returns stripped, lines
rejoined with `\n` — so a document-relative offset would not index into the
stored section body anyway.

`source_span` therefore means: **code-point offsets into
`document_sections.body`, half-open, `[start, end)`.** The MCP `propose` tool
already describes it as offsets within the section, so this is a clarification
rather than a change.

## Verbatim quote verification

This is the anti-hallucination mechanism, settled in `docs/00-handoff.md`. A
candidate atom whose quote does not appear in the section it names is not
stored. There is no repair step.

### In the worker

1. Locate the quote in the section body, exactly, with no normalisation. Not
   trimmed, not whitespace-collapsed, not unescaped, not case-folded. Every
   normalisation is a place where the stored span stops indexing the stored
   body.
2. If it is absent, the candidate is dropped and counted. It is never
   fuzzy-matched to the nearest passage. `docs/02-principles.md` (8) asks what
   would disprove a claim; a quote that does not appear disproves it, and
   repairing the quote manufactures the provenance the invariant exists to
   guarantee.
3. If it appears more than once, take the first occurrence. The ambiguity is
   harmless: verification is an equality against `substring`, which any
   occurrence satisfies. Choosing the "right" one would be a judgement call
   with no observable consequence.

### In the database

A worker discipline is not enforcement. `docs/04-data-model.md` is blunt about
this: *"a constraint that lives only in application code is a convention with
better marketing."*

Verification cannot be a `CHECK`, because a `CHECK` cannot reference another
table. It becomes a `BEFORE INSERT OR UPDATE` trigger on `atoms` that performs
one indexed lookup of the cited section and compares:

```sql
substring(s.body
          from lower(new.source_span) + 1
          for  upper(new.source_span) - lower(new.source_span))
  = new.source_quote
```

`int4range` canonicalises to `[)`, so `lower` and `upper` are well defined.
`substring(text from int for int)` is 1-based, hence the `+ 1`. A span that
runs past the end of the section yields a shorter string, and a span that
starts past the end yields the empty string — both fail equality, the second
only because `atoms_source_quote_not_blank` already forbids an empty quote.
That existing check is load-bearing here, which is worth knowing before
someone relaxes it.

An empty range is also rejected outright, with
`check (not isempty(source_span))`. Postgres returns `NULL` from `lower()` and
`upper()` on an empty range, and a `NULL`-propagating comparison inside a
trigger is a confusing way to say "this atom cites nothing".

The trigger costs one lookup per atom insert, on the write path only. It buys
the phase-1 exit gate as a property rather than as a test result.

**This closed a hole phase 0 shipped.** Until phase 1a,
`POST /v1/projects/{id}/atoms` accepted any `sourceQuote` and any `sourceSpan`
and stored them unverified (`packages/api/src/routes.ts`, `createAtom` in
`packages/db/src/repositories/atoms.ts`), and two surfaces reached it: that
endpoint, and the MCP `propose` tool — so an agent wrote atoms whose quotes
nobody checked. It was survivable only because every one of them is born
`provisional` and a human reads it before it counts; the CLI has no atom-create
command at all (`packages/cli/src/run.ts` exposes only `atom ls`). From the
moment extraction writes them in bulk, unread, it would have been the difference
between provenance and decoration. The trigger is
`standfast_verify_atom_quote()` in `packages/db/migrations/0002_extraction_invariants.sql`,
and both write paths now go through it.

### The gate

The exit criterion is this query returning zero rows, over the whole database:

```sql
select a.id
from atoms a
join document_sections s on s.id = a.section_id
where substring(s.body
                from lower(a.source_span) + 1
                for  upper(a.source_span) - lower(a.source_span))
      is distinct from a.source_quote;
```

Zero, not "low". There is no acceptable rate of atoms that cite text which is
not there.

### The section must belong to the document

A second hole, cheaper to fix, and also closed by phase 1a. `atoms.document_id`
and `atoms.section_id` carried separate foreign keys with nothing tying them
together, so an atom could name document A and a section of document B. The
verification trigger would not catch it — the quote verifies against whichever
section is cited — and the `read` tool would then have reported a provenance
that is half wrong.

Phase 1a added `unique (document_id, id)` to `document_sections` and replaced
the single-column key on `atoms` with

```sql
foreign key (document_id, section_id)
  references document_sections (document_id, id) on delete cascade
```

which is the same trick `docs/04-data-model.md` already uses to make "only a
human ratifies" unrepresentable. Agreement between two columns is a job for a
composite key, not for a code path someone has to remember to call.

## Deduplication

Two documents saying the same thing should not produce two atoms. The bands
are settled in `docs/00-handoff.md`:

| Cosine similarity | Decision | Cost |
| --- | --- | --- |
| < 0.80 | distinct — write the candidate | none |
| 0.80 – 0.93 | ask an LLM judge | one model call, in the worker |
| > 0.93 | duplicate — suppress the candidate | none |

**These are similarity, not distance.** `docs/00-handoff.md` writes "cosine
< 0.80 distinct", which only reads correctly as similarity. pgvector's `<=>`
operator returns cosine *distance*, so the implementation compares
`1 - (a <=> b)`. Getting the orientation backwards is silent and total —
everything merges into the first atom ever written, the corpus stops growing,
and nothing errors. It is written down here so the question is asked once.

**The thresholds are starting points and are to be recalibrated on a real
corpus.** `docs/14-roadmap.md` is explicit that the labelled corpus exists
before the first threshold is tuned. Recalibration without one is fitting the
system to the last example somebody looked at, and it feels like progress the
entire time it is happening.

### Scope

Candidates are compared against existing atoms in the **same project**, not
the same org. Atoms are project-scoped knowledge; the same sentence in two
projects is two decisions that happen to agree, and collapsing them would make
one project's ratification silently govern another's.

### What "merge" means

It means **the candidate is not written, and the incumbent is not touched.**

That is narrower than the word suggests, and deliberately. Three reasons:

- An atom has exactly one `section_id`. There is no representation of an atom
  with two provenances, and adding one would weaken the projection invariant
  to "an atom cites at least one thing", which is not the same guarantee.
- If the incumbent is canonical, editing it is an extractor changing
  human-ratified knowledge. `docs/02-principles.md` (6): recommender, never
  actor. The mechanism that stops an agent promoting an atom should not be
  quietly bypassed by an agent rewriting one.
- Writing a provisional twin of a canonical atom creates review work whose
  only possible outcome is "reject, duplicate". Ratification throughput is a
  first-class metric (`docs/02-principles.md`, 5); filling the queue with
  guaranteed rejections moves it in the wrong direction.

So a near-duplicate of a canonical atom changes nothing at all. It is recorded
as a suppression, and the canonical atom stands.

### The judge

Only in the 0.80 – 0.93 band, only in the worker, never on the read path. It
answers one question — same claim or different claim — and it is prompted to
falsify: *name a situation in which these two statements would rule
differently*. Asking for support finds support.

Its verdict is asymmetric by construction. "Duplicate" suppresses a
**candidate**; it can never modify, demote or delete an existing atom. The
judge has no write path to anything that already exists.

### Determinism

Dedup is order-dependent: first writer wins, so the same set of documents
processed in a different order yields a different — equally correct — set of
atoms. That is fine for a running system and fatal for an evaluation harness,
which would measure the noise.

A full rebuild therefore processes in a fixed order: documents by `path`,
sections by `ordinal`, candidates by their position within the section. The
ordering is part of the extractor version, not an implementation detail.

### Similarity search has no index in phase 1

`docs/14-roadmap.md` puts HNSW in phase 2. Phase 1 only writes vectors, and
dedup scans the project's atoms sequentially. Whether that is acceptable
depends on corpus size, which nobody has measured; no latency figure is
claimed here. If it becomes the bottleneck before phase 2, the index moves
forward — it is one migration and it does not change any decision in this
document.

## When a section changes

This is where phase 1a changed code that already existed.

`putDocument` (`packages/db/src/repositories/documents.ts`) used to delete every
section of the document and re-insert the new set. `atoms.section_id`
references `document_sections` **on delete cascade**. So pushing a document —
even a byte-identical one — destroyed every atom derived from it.

In phase 0 that was nearly invisible: nothing wrote atoms in bulk, so a
re-upload destroyed only whatever a human or a `propose` call had put there by
hand — rare, and rarely noticed. From phase 1 it would have been a defect that
deletes human-ratified knowledge in response to an agent-triggered write, which
is roughly the inverse of the second invariant.

The replacement, now in `reconcileSections`, is a match rather than a rewrite:

1. Compute the new sections from the body.
2. Match new sections to existing rows **by `section_hash`**, in ordinal
   order, one-to-one. A multiset match, not a lookup: a hash can legitimately
   repeat within one document, because two sections with the same heading path
   and the same body are the same content twice, and the hash deliberately
   excludes the ordinal.
3. Matched rows keep their `id`. Only `ordinal` is updated. Their atoms are
   untouched and no job is enqueued.
4. Existing rows with no match are deleted. Their atoms cascade away, which is
   correct: the text those atoms cite no longer exists in the document, and an
   atom whose quote cannot be verified has no reason to be trusted.
5. New sections with no match are inserted and enqueued for extraction.

Exit criterion 2 falls out of step 5 being empty for an unchanged document.

**One migration was required to make step 3 possible.**
`document_sections_document_ordinal_key` was a unique *index*, and Postgres
cannot defer a unique index. Moving a section from ordinal 4 to ordinal 2
transiently collides mid-statement. Phase 1a replaced it with a deferrable
`UNIQUE` constraint and sets it deferred for the duration of that transaction.

Step 5 is the enqueue site, and it is the only one. Phase 1c passes an enqueue
port into `putDocument` rather than enqueuing from the route, because the HTTP
endpoint is not the only writer: the MCP server, the CLI and the eventual sync
daemon would each have to remember. A boundary you can cross by forgetting
something is not a boundary.

Considered and declined: shifting every ordinal by a large offset and then
setting the final values. Two writes per section and a magic number, to avoid
a constraint change that is three lines.

## When a document is deleted

The cascade does the obvious thing: sections go, and their atoms go with them.
Nothing about that needs designing.

What needs designing is the second-order effect. A candidate suppressed as a
duplicate of an atom in the deleted document was real knowledge that the
system chose not to store twice. When the incumbent disappears, the knowledge
disappears with it, and the section that also stated it is not re-extracted,
because its hash never moved.

So suppressions are recorded, and the record is what repairs this.
`atom_suppressions.duplicate_of_atom_id` references `atoms` **on delete set
null**, with a partial index on the null case. Deleting a document leaves
behind exactly the set of suppressions whose target no longer exists, and a
job re-extracts those sections.

Considered and declined: let it go, and rely on the next full rebuild. The
failure is silent and the loss is real — someone deletes one document and
loses a convention that a second document also stated. A silent loss of
knowledge is the failure mode this product exists to fix.

`on delete cascade` on that column was also considered and is worse: it
destroys the only evidence that the repair is needed, in the same statement
that creates the need.

## Re-derivability

`docs/02-principles.md` (7): documents are the source, atoms are a projection,
and when models improve everything regenerates. The schema already makes the
strong half true — there is no way to author an atom without a section to
cite, so nothing exists only as an atom.

The weak half is worth being honest about.

**Ratification does not re-derive.** `status`, `ratified_by` and `ratified_at`
live on the atom row, and `atom_events.atom_id` cascades on atom delete, so
the audit log does not survive either. A literal
`delete from atoms where project_id = $1` followed by a re-run returns the
whole corpus to `provisional` and destroys the record of every human decision
ever made about it. That operation is safe in the sense the exit criterion
means — the atoms come back — and catastrophic in the sense a user means.

So phase 1 separates the two things the roadmap's third criterion is asking
about.

**The criterion is a test.** It runs on a project with no ratified atoms and
proves one thing: that the extractor is complete, and that no atom in the
corpus depended on a manual step. It is not an operational procedure and
nothing in the CLI should offer it as one.

**The operation is a re-projection.** When the extraction model, the embedding
model, the prompts, the thresholds or the sectioning algorithm change, the
project is re-extracted at a new `extractor_version` and the output is
*matched* against the existing atoms using the same dedup bands. A produced
statement that matches an existing atom above the merge threshold does not
create a new row; the incumbent stands, with its ratification intact. Only
genuinely new statements enter the queue.

**An atom the new extractor no longer produces is not deleted.** It is flagged
for human review and nothing else. Its section still exists, its quote still
verifies, and a model that has stopped mentioning something is not evidence
that the something is false. Recommender, never actor — an extractor that can
retire ratified knowledge is an agent deciding what humans decided.

### Why re-embedding is not a shortcut

Changing only the embedding provider looks like it should be a cheap backfill:
recompute vectors, keep atoms. It is not, because the existing atom set is the
output of dedup decisions taken under the old geometry. Re-embedding without
re-deduplicating leaves a corpus that is internally inconsistent with its own
merge threshold, and nothing surfaces that.

A provider change is therefore a new `extractor_version` and a full
re-projection, which is exactly what `extractor_version` exists to make
queryable. The cost is real and is the price of the invariant.

## Everything it writes is provisional

The worker calls the same `createAtom` that the API calls. It has no `status`
parameter (`packages/db/src/repositories/atoms.ts`), the request schema has no
`status` field, and the database refuses `canonical` without a ratifier. There
is no extraction-specific write path, and there should never be one.

The extractor writes `atom_events (event = 'proposed', actor_id = …)`, and
`actor_id` is `NOT NULL` against `actors`. So each org gets one actor with
`kind = 'agent'` representing the extractor, created alongside the org. This
is not bookkeeping: because `actors` is unique on `(id, kind)` and `atoms`
carries the composite key to `(id, 'human')`, an actor created as an agent can
never appear as a ratifier. The extractor inherits the guarantee rather than
being granted an exception to it.

Considered and declined: writing extraction atoms with a null actor, or with
the actor of whoever pushed the document. The first breaks the audit log the
ratification metric is computed from; the second attributes a model's output
to a human, which is the one attribution error this system cannot afford.

## Long sections

A document with no headings is one section. Model context is finite.

Windowing is an implementation detail of the model call and never of storage.
A long section is extracted in overlapping windows, spans are computed against
the whole section body regardless, and the section remains one row with one
hash. Splitting the row instead would change section identity as a function of
the model's context length, which would make every model upgrade a re-extract
of the entire corpus.

The window size and overlap are unchosen. See *Open*.

## Schema phase 1 adds

Phase 1a shipped all of this, in `0002_extraction_invariants.sql`:

| Object | Purpose |
| --- | --- |
| `atoms.embedding vector(1024)` | dedup similarity. No index until phase 2 |
| `atoms` trigger, before insert/update | verbatim quote verification |
| `atoms check (not isempty(source_span))` | an atom cites something |
| `document_sections unique (document_id, id)` | target of the composite key |
| `atoms fk (document_id, section_id)` | the section belongs to the document |
| `document_sections` ordinal key, deferrable | reordering within one statement |
| `section_extractions` | which hash was extracted by which version |
| `atom_suppressions` | what dedup discarded, and what it duplicated |

Phase 1c adds the bookkeeping the pipeline needs and cannot reconstruct
afterwards:

| Object | Purpose |
| --- | --- |
| `atoms.extractor_version` | which extractor produced it, and whether one did |
| `section_extractions.project_id` | the scope every question about extraction asks in |
| `section_extractions.candidates_total` / `candidates_dropped` | the drop rate the *unsupported* gate is computed from |
| `section_extractions.attempts`, `lease_expires_at` | a crashed worker, distinguished from a running one |
| `actors.system_key`, unique per org | names the extractor actor without matching on a display name |

`atoms.extractor_version` is nullable, and the null means something: an atom no
extractor produced. Without it, a re-projection computes "an atom the new
extractor no longer produces" by subtraction over every atom citing the
section — including the ones a human wrote through `propose`, which it would
then flag as extractor-abandoned. That is the inverse of the intent, and it
cannot be repaired later because the attribution was never recorded.

`section_extractions` is keyed `unique (section_id, extractor_version)` and
carries the section hash it saw, the run status, and timings.
`extractor_version` is a single opaque string derived from the prompt version,
the extraction model, the embedding model, the dedup thresholds and the
sectioning algorithm version. One column rather than five, because any of them
changing invalidates exactly the same thing, and "which sections are stale"
should be one equality rather than a five-way comparison nobody writes
correctly twice. What changed between two versions is in the job log; it does
not need to be in a key.

Keying on `section_id` rather than on `section_hash` was a choice. Hash-keying
would let two documents with an identical section share one extraction, which
is a real saving. Declined: an atom cites a section, not a hash, so the shared
result would still have to be projected onto each section separately, and the
saving is one model call in exchange for a second notion of section identity.

### The wire allowlist is not optional for these

`packages/db/src/schema/wire-allowlist.ts` is the enforcement point for
invariant 3, and `TENANT_TABLES` is derived from its keys.
`schema-guards.integration.test.ts` iterates that list to assert
`relforcerowsecurity` and the org-isolation policy. **A table absent from the
map is a table the guard suite never checks** — it is not merely unlisted, it
is unverified. `section_extractions` and `atom_suppressions` go into the map
in the same migration that creates them.

`atoms.embedding` also has to be added, or the column-equality test fails.
Note what the allowlist is: a per-table column *inventory*, not a projection —
`api_keys.hash` is in it and obviously never crosses the wire. What actually
crosses is the Zod schema, and `AtomSchema` already omits `source_span` and
`superseded_by`. `embedding` belongs in the allowlist and must not be added to
`AtomSchema`; a 1024-float array on every atom in a context pack would be an
expensive way to send nothing anyone can read.

## Considered and declined

Recorded so each question is asked once.

- **Extraction on the read path, for a section that has none.** It would make
  the first `context` call after a push arbitrarily slow, and the token budget
  and p95 are contracts (`docs/02-principles.md`, 4).
- **Extracting from the document body rather than from sections.** Then the
  unit of incremental work is the document, one typo re-extracts everything,
  and `document_sections.section_hash` has no consumer.
- **Fuzzy or normalised quote matching.** It converts a hallucination into a
  citation. The whole value of `source_quote` is that it is checkable by
  string equality.
- **Letting extraction write `canonical` for high-confidence output.** Agent
  self-ratification in a disguise (`docs/14-roadmap.md`, *deliberately not on
  the roadmap*). The database refuses it anyway.
- **A `confidence` column on atoms.** It reads as a ratification shortcut, and
  the only honest use of it — ordering the human queue — belongs to the
  ratification surface in phase 4, computed there.
- **Merging by rewriting the incumbent's statement.** An extractor editing a
  ratified atom, with no ratification of the edit.
- **Training or fine-tuning an extraction model.** Re-derivability means we
  regenerate when models improve; owning a model means we are the reason they
  do not (`docs/14-roadmap.md`).
- **Non-Markdown input.** Deferred past phase 4, and the sectioner is the
  reason it is cheap to defer: it takes text and returns sections, so a future
  connector adds a parser, not a second extraction path.

## The models phase 1d binds

Three ports, three decisions, and the reasoning rather than only the names —
because the names will change and the reasoning is what tells the next person
whether the change is safe.

**Embedding: `voyage-3`.** Native 1024, so `atoms.embedding` needs no
truncation. Its 32,000-token input limit is loose enough that the section
window is an extraction decision rather than a provider constraint. Hosted
only — `docs/14-roadmap.md` carries the self-hostable adapter that Egress rule
4 needs as its own open item rather than pretending this closed it.

**Extraction: `claude-opus-5`.** Extraction runs over every section of every
document, so this is the cost-sensitive call and it went to the more capable
model anyway. The reason is what extraction precision measures: the
*unsupported* rejection class is a statement that does not follow from its
quote, and `docs/12-evaluation.md` makes a non-zero unsupported count a gate
failure rather than a low score. Judgement about entailment is exactly the
thing the cheaper model is cheaper at.

**Judge: `claude-sonnet-5`.** Deliberately not the extractor. A same-model
judge in the 0.80–0.93 band restates the extractor's own view rather than
offering a second one — the identical argument `docs/12-evaluation.md` uses to
decline an LLM labeller, applied to ourselves. Judge calls fire only inside the
band, so the cost of the second opinion is small. They remain the same family
and may still share a blind spot; that is a real limit, it is invisible from
inside, and only the pair corpus will show it.

**None of this is tuned.** No prompt has been written against a result, and no
threshold has moved. `docs/14-roadmap.md` requires the labelled corpus before
either, and the corpus has no labels.

## What phase 1c settled

The design left several things to whoever built the pipeline. These are the
answers, recorded here because the next reader will otherwise assume they are
still open.

**A failed extraction retries at the same version.** The unique key on
`(section_id, extractor_version)` leaves a retry no choice but to reuse the
row, so `attempts` is a counter rather than a row per try. A failed row and a
crashed one are both reclaimable; the alternative — refusing to retry without a
version bump — makes a transient provider outage in 1d something an operator
fixes at a SQL prompt.

**A crashed worker is found by an expired lease, not by the age of
`started_at`.** `section_extractions.lease_expires_at` is set on claim and
cleared on completion, and takeover is a conditional `UPDATE` whose `WHERE`
clause is the lock — two would-be takers cannot both match it, so nothing needs
an advisory lock. Inferring death from how long `started_at` has been sitting
there would make the answer a function of how slow extraction happens to be
that week.

**The version in the job payload wins.** A worker whose configured ports
disagree with it refuses to start rather than extracting at a version nobody
asked for: `section_extractions` would otherwise fill with rows keyed by a
string describing something else, and every one of them would look fine.

**A quote that fails verification is counted in
`section_extractions.candidates_dropped`, not in `atom_suppressions`.** That
table is what *deduplication* threw away. A row in it with a null
`duplicate_of_atom_id` would poison `atom_suppressions_orphaned_idx`, whose
entire purpose is finding suppressions whose winner is gone.

**`atom_suppressions.reason` is a closed set**: `duplicate:threshold`,
`duplicate:judge`, `duplicate:batch`. "What did the upper band discard at this
version" should be a query and not a string match.

**The candidate cap lives in the worker, and records that it applied.**
`section_extractions.candidates_truncated` is set, never inferred from a count,
for the same reason a context pack sets `truncated`: a cap that applies
silently reads as a section that had nothing more to say. In the queue instead,
it would tell you a cap fired and never which sections hit it.

**Processing order is carried by the enqueue, not hoped for from the queue.**
This one was a defect rather than a decision. pg-boss fetches
`ORDER BY priority desc, created_on, id`, and every job sent inside one
transaction shares a `created_on` — so the tie broke on a uuid, and two
sections of one document were processed in a random relative order. Dedup is
first-writer-wins, so which of two similar atoms survived was a coin flip, and
a rebuild did not reproduce its own corpus. Each enqueue now carries an
explicit priority counted down from its batch size, which makes the fixed order
above a property of the write rather than of whatever the consumer fetches.

## Open

- **Extraction precision, and its bar.** `docs/14-roadmap.md` owns the number
  and does not have one. It cannot be chosen before the labelled corpus exists
  (`docs/02-principles.md`, 10), and the corpus is `docs/12-evaluation.md`'s
  job.
- **Window size and overlap for long sections**, and whether a section above
  some length should instead be reported as a document-structure problem to
  the human. voyage-3's 32,000-token input limit means the embedder no longer
  sets the ceiling, so this is an extraction decision rather than a
  provider-imposed one.
- **Retry policy and the poison-job case.** A section that makes the model
  fail deterministically will fail every redelivery. Phase 1c settled the
  mechanism — a failed row is retryable at the same version and `attempts`
  counts the tries — but not the ceiling: what number of attempts should stop
  the retrying, and whether a dead-lettered section shows up in `status`. It
  should.
- **Cost per document.** Unknown. No figure is claimed anywhere in this
  document, and none should be quoted until a real corpus has been run.
- **Whether `WIRE_ALLOWLIST` should distinguish "columns this table has" from
  "columns that cross".** It currently conflates them, which works and reads
  slightly wrong. `docs/04-data-model.md` owns the answer.

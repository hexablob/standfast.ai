<!-- docs/06-retrieval.md -->
# Retrieval

> **Status: built, except the reranker, and unmeasured.** Phase 2 shipped the
> pipeline described here. Migration `0007` adds the four indexes it needs —
> `atoms_search_vector_idx`, `atoms_trigram_idx`, `atoms_embedding_hnsw_idx`
> and `atoms_structural_idx`. The four candidate generators are in
> `packages/db/src/repositories/retrieval.ts`, RRF fusion at k=60 in
> `packages/core/src/rrf.ts`, MMR in `mmr.ts` and budgeted assembly in
> `pack.ts`; `context` and `search` are MCP tools, and the `SessionStart` and
> `UserPromptSubmit` hooks call them. **The cross-encoder reranker is not
> built**, and no deployment can turn one on:
> `packages/core/src/egress.ts` refuses a `reranking` allowlist entry outright.
> A response names the stages that did not run in `skipped`, so a caller is
> told rather than left to infer. Every constant here — k=60, λ≈0.7, the
> generator limits — is still the default it was chosen as, because the corpus
> that would recalibrate it does not exist. **No phase-2 exit criterion is
> claimed**: retrieval precision under budget and the declared p95 are both
> unmeasured.

## What retrieval owes

`docs/01-thesis.md` splits the product in two: cold start and tool divergence
are retrieval problems, and silent drift is a verification problem. Retrieval
is table stakes. It is also the half that runs constantly — `context` fires on
every `SessionStart` through a hook, whether or not the model chose to call it
(`docs/08-mcp-server.md`). That single fact sets every constraint below. A
component invoked automatically, in every session, cannot have a cost the user
notices, or the user removes the hook, and the sessions that lose it are the
ones that needed it most.

Three stages, three distinct jobs, and it is worth keeping them separate in
your head because the failure of each looks different:

| Stage | Job | Failure looks like |
| --- | --- | --- |
| Candidate generation + fusion | recall | the governing atom is not in the list at all |
| Reranking | precision | the governing atom is at position 30 |
| Assembly | budget | the pack is three phrasings of one convention |

## Why migration 0000 already created the extensions

`0000_foundation.sql` runs `CREATE EXTENSION IF NOT EXISTS "vector"` and
`"pg_trgm"` with no vector column, no trigram index, and no consumer. The
comment in the file gives the reason: it costs nothing and proves pgvector is
available on the host *today*, rather than discovering in phase 1 that the
retrieval design does not run where the database lives.

That is worth restating from retrieval's side, because it is retrieval that
would have paid. Postgres hosting is Neon (`docs/00-handoff.md`). The whole
design below assumes an approximate vector index sitting in the same database
as the rows, inside the same transaction, under the same RLS policies. If
pgvector were unavailable on the chosen host, that assumption fails and the
answer is not "add an extension" — it is a second datastore, a second
access-control system, and a copy of customer prose living outside the row
that governs it. Two lines of SQL in the first migration bought the right to
not consider that.

`tsvector` needs no extension; full-text search is core Postgres. That is why
0000 creates two extensions and not three, and it is the reason the lexical
generator is the cheapest of the four to stand up.

**What phase 2 must add to the same check.** Proving the extension exists is
not proving the extension is new enough. The mitigation for the RLS/ANN
interaction below needs iterative index scans, which are a recent pgvector
feature. Phase 2 asserts the extension *version* at startup, in the same place
and for the same reason as `assertTenantIsolationApplies()`
(`docs/03-architecture.md`): a version that is too old does not fail loudly,
it silently returns fewer rows.

## The unit

Retrieval ranks **atoms**. Not sections, not documents, not source code —
there is no representation of source code anywhere on this side of the wire
(`docs/01-thesis.md`).

**`context` packs canonical atoms only.** This follows from invariant 2 rather
than from taste: a provisional atom is an agent's guess awaiting a human, and
injecting it unprompted into every future session is precisely the failure
that ratification exists to prevent — the system confidently repeating an
agent's guess back to the next agent, now with the authority of having been
injected by a hook. Considered and declined: including provisional atoms with
a `status` marker and letting the agent decide. Declined because the marker is
one line of an envelope competing with the statement itself for attention, and
because it makes the gate advisory. `search` may surface provisional atoms
when the caller asks for them, since `search` is a pull the model chose to
make; `context` is a push it did not.

Consequence worth naming: a project with forty provisional atoms and none
ratified gets an empty pack. That is correct behaviour and a product failure
at the same time, and it belongs to ratification throughput
(`docs/02-principles.md`, 5), not to retrieval. `status` is the tool that
makes it visible.

**Embeddings carry their model identity.** Whatever column or side table phase
1 adds — that shape belongs to `docs/05-extraction.md` — the vector is stored
with the identifier of the model that produced it. Retrieval demands this for
one reason: mixing two embedding models in one index produces a similarity
score that is meaningless and looks fine. A model change is a re-derivation of
every vector (`docs/02-principles.md`, 7), not a migration, and the identity
column is what makes an incomplete re-derivation a detectable state rather
than a silent one.

## The four candidate generators

Each covers a query class the others get wrong. Four, not one, because a
single retriever's misses are *systematic*: the same class of question fails
every time, the user learns that the tool "does not know about X", and stops
asking. Fusion turns a systematic miss into a rank penalty.

### 1. Dense vector — paraphrase

HNSW over the atom statement embedding, 1024 dimensions, cosine distance.

Good at: the agent describing its task in words the atom does not use.
*"I'm adding a background job for document parsing"* against *"the job queue is
pg-boss; enqueue must be transactional"* shares no content word and is the
same subject. This is the generator that makes `context` feel like it
understands the request.

Bad at: rare project-specific tokens the embedding model never saw. It will
happily place `standfast_app` near `standfast_auth` near `standfast_api` and be
confidently wrong about which one governs.

### 2. Lexical full text — the project's own vocabulary

`tsvector` over statement and source quote, `websearch_to_tsquery` for the
query, `ts_rank_cd` for the score.

Good at: exact terminology, acronyms, and the words a project has redefined
for itself. Every codebase has a handful of nouns that mean something local —
"atom", "pack", "actor" — and lexical matching gets them right by not knowing
anything. Also good at rare tokens, which is exactly generator 1's weakness.

Bad at: paraphrase, and at anything where the shared vocabulary is zero.

### 3. Trigram — identifiers and paths

`pg_trgm`, GIN with `gin_trgm_ops`, `similarity()` against the same text.

Good at: `withActor`, `packages/db/src/schema/rls.ts`, `STANDFAST_ORG_ID`.
Tokenisation destroys these — a `tsvector` sees `packages`, `db`, `src` and
loses the fact that they were one string — and an embedding model has no
opinion about a symbol it has never seen. Trigrams match on substrings, so
`schema/rls` finds an atom whose statement names `packages/db/src/schema`.
Also the only generator with typo tolerance.

This is also where the deterministic query preparation lives: splitting a path
into components, splitting `camelCase` and `snake_case`, lowercasing. All of
it is string manipulation with no model in it, which is why it is allowed on
the read path at all.

**The honest limit of path scoping.** `context` accepts file paths, and there
is no table joining a source file to the atoms that govern it, because there
is no representation of source code. So a path is matched as *text* — against
statements and quotes that happen to name it, which project documents do
constantly ("`packages/core` is pure domain"). That works better than it
sounds and worse than a real index. It gets materially better at phase 3, when
reconciliation verdicts supply `file_path` → `atom_id` associations that were
*observed* rather than indexed (`docs/07-reconciliation.md`). Recording the
sequencing here so nobody builds a file tree to fix it.

### 4. Structural — the generator with no query

No free-text scoring at all. Given whatever the request names — a project, a
document, a section, or the atoms already selected — it returns canonical
atoms by graph proximity: same document, same section neighbourhood,
supersession chain, plus a prior on `kind` and recency.

Good at: `scope: "project"`, and at cold start, where there is no question yet.
It is also the coherence generator: a pack containing an atom whose successor
was left out is worse than a pack without either, because the agent acts on
the superseded one.

**And it is the reason session start needs no model at all.** The
`SessionStart` hook fires with a project and no query. Generator 4 answers it
alone, from btrees and a sort, with nothing to embed and nothing to rerank.
The highest-frequency and most latency-sensitive call in the system is the one
with the least machinery in it. That is not an accident of the design; it is
the part of the design worth protecting when the others are tuned.

### How the modes map

`search` takes `mode: "lexical" | "semantic" | "hybrid"`
(`docs/08-mcp-server.md`). One pipeline, two terminations:

| Call | Generators | Terminates with |
| --- | --- | --- |
| `search` `"lexical"` | 2, 3 | ranked list under the envelope |
| `search` `"semantic"` | 1 | ranked list under the envelope |
| `search` `"hybrid"` (default) | 1, 2, 3, and 4 when a scope is given | ranked list under the envelope |
| `context` | all four | packed set under `budget_tokens` |

## Fusion: RRF at k=60

Reciprocal Rank Fusion. For each atom, sum over the generators that returned
it:

```
score(a) = Σ_g  1 / (k + rank_g(a))          k = 60
```

**Why ranks and not scores.** The four generators produce numbers on
incomparable scales: cosine distance in [0, 2] where smaller is better,
`ts_rank_cd` unbounded and dependent on corpus statistics, trigram similarity
in [0, 1], and generator 4's score is whatever we decide it is. Combining them
requires normalising each to a common range, which requires knowing each
distribution, which changes as the corpus grows — so the normalisation becomes
a tuning job that has to be redone at every scale, silently degrading in
between. RRF discards the scores and keeps only the ordering, which is
comparable by construction and stable as the corpus grows.

**Why k = 60.** The constant damps the top of each list so that no single
generator can dominate the fused order. At k = 60 the gap between rank 1 and
rank 2 is 1/61 against 1/62 — nearly nothing — while the gap between rank 1
and rank 100 is large. It is the value from the original RRF paper and we
inherited it; it is a default, not a measurement. The roadmap's phase 2 exit
criterion 5 requires that the constants in use are the recalibrated ones and
that the corpus they were calibrated on is committed. Shipping k = 60
unchanged would mean nobody checked.

**Why fusion beats picking the best retriever.** Two reasons, and the second
is the one people miss.

The first is quality: the generators' failures are largely uncorrelated. An
atom that any one of them ranks highly enters the candidate set, so recall is
roughly the union rather than the best single member. And RRF needs no
training data, which matters because we have none — a learned fusion would
need the labelled corpus that phase 1 has not produced, and tuning weights
without one is the exact failure `docs/02-principles.md` (10) names.

The second is availability. Generator 1 depends on a query embedding, which is
the one part of the read path that reaches outside the process. When it is
slow or down, generators 2, 3 and 4 still answer, and the fused order degrades
rather than the request failing. Four generators is a redundancy argument as
much as a quality argument.

**One statement, one round trip.** Fusion is computed in SQL, not in
application code, as a single query with one CTE per generator and a
`union all` into a grouped sum. Four separate round trips would multiply tail
latency by four under a pooled connection, and the p95 is a contract.

```sql
with dense as (
  select atom_id, row_number() over (order by embedding <=> $1) as rank
  from … limit $n
), lexical as (
  select atom_id, row_number() over (order by ts_rank_cd(tsv, q) desc) as rank
  from …, websearch_to_tsquery('english', $2) q where tsv @@ q limit $n
), trigram as ( … ), structural as ( … )
select atom_id, sum(1.0 / (60 + rank)) as rrf
from   (select * from dense union all select * from lexical
        union all select * from trigram union all select * from structural) s
group  by atom_id
order  by rrf desc
limit  $m;
```

The fused list is then reranked and assembled outside SQL. RRF, MMR and the
packer are pure functions in `packages/core` — no I/O, testable without a
database, per the conventions in `CLAUDE.md`. The four candidate queries live
in `packages/db`.

## Two model calls, named

`docs/03-architecture.md` left this open and said this document owns the
answer. Here it is, and it is worse than the open question stated, because
there are two model calls on the read path, not one.

> *"No generative model call between an agent's question and its answer: the
> pipeline admits only pinned, bounded embedding and reranking calls, and
> nothing that generates text. Token budget and p95 latency are contracts, not
> targets."* — `docs/02-principles.md` (4)

1. **The query embedding.** Generator 1 cannot run without embedding the
   query, and the query is not known in advance.
2. **The cross-encoder reranker.** It scores (query, atom) pairs, so it cannot
   be precomputed either.

Both sit between the question and the answer. Note what this rules out: "move
it off the read path" works for atom embeddings, which are computed once at
extraction time, and does not work for either of these. Principle 4 read *"no
model call"* flatly until phase 2 forced the question, and that reading does
not relocate the reranker, it deletes it — and deletes dense retrieval with
it, leaving three generators and no paraphrase matching. The wording was
amended rather than the pipeline (`docs/14-roadmap.md`, phase 2).

**The reading the amendment encodes.** Principle 4 forbids a set of
*properties*, not a class of software. A generative call on the read path
makes latency unbounded, output non-reproducible, and cost proportional to
sessions — and, if hosted, puts a third party's availability in front of
every session start. Those are the harms. A model with pinned weights,
deterministic output and a measured ceiling has none of them.

That is a real distinction, and it is a distinction about *which* model call,
not about whether there is one. This document does not pretend otherwise.

So the properties are written down as conditions, and a model call is
permitted on the read path only if it meets all five:

1. **Pinned, versioned weights.** Same input, same ranking, forever, and
   reproducible after a redeploy. The version is recorded in the response, so
   an evaluation run can be attributed to a ranking regime.
   `docs/02-principles.md` (12): pin, sign, attest; never execute the latest
   published version at every startup.
2. **Operated by us, in the region of the database.** Not a third-party hosted
   endpoint. Its latency would be somebody else's SLO, and its weights change
   without a version bump, which breaks condition 1 without telling anyone.
   There is a privacy argument too: the query — a task description written by
   the developer — already crosses to our server because retrieval cannot
   happen otherwise, and sending it onward to a third party is a second
   boundary crossing that no allowlist currently covers
   (`docs/02-principles.md`, 9). **Settled: the allowlist now covers it, and
   refuses it.** `query-embedding` is an egress purpose the disclosure log can
   record and `PERMITTED_PURPOSES` does not admit, exactly as `reranking` is —
   `docs/13-threat-model.md` (*Egress*, rule 2) treats a live task description
   as a procurement decision separate from the batch job over stored prose, and
   reusing the `embedding` purpose for it would have stretched a consent
   granted for the second to cover the first, with nothing failing.

   Two mechanisms rather than one, because they refuse different things.
   `parseEgressAllowlist` refuses the purpose when the environment is read, so
   no deployment can be *configured* to make the call.
   `packages/api/src/adapters/query-embedder.ts` refuses any destination that is
   not one the operator runs, so on the day the first refusal is lifted this
   condition is enforced by a constructor rather than promised by this
   paragraph.

   Note what that does **not** unblock. Condition 4 below wants a measured p95
   inside `context`'s own, and `context`'s p95 is unchosen and unchoosable
   until a corpus exists. All five conditions are required together, so
   generator 1 does not run today even for a deployment that hosts its own
   model — and the existence of the adapter is not an argument that it should
   (`docs/14-roadmap.md`).
3. **A bounded work unit.** The reranker sees exactly the top N of the fused
   list, N fixed. Its cost is a constant, not a function of corpus size, so
   the p95 does not degrade as customers grow.
4. **A measured p95 that fits inside `context`'s p95 with room for
   everything else.** Enforced by a test, not by intention. The reranker's
   share of the budget is chosen at the same time as the total; choosing the
   total first and fitting the reranker into the remainder is how a reranker
   ends up either useless or over budget.
5. **Skippable, visibly.** If a model call exceeds its deadline or is
   unavailable, retrieval proceeds without it and says so in the response.
   The dense generator drops out of the fusion; the reranker leaves the fused
   order untouched. Silent degradation would mean two ranking regimes that an
   evaluation cannot tell apart.

**The residual risk, stated.** Condition 5 means two regimes exist in
production. A precision bar met only with the reranker is a bar that fails
whenever the reranker is slow, so `docs/12-evaluation.md` must measure both —
the reranked pack and the fused-only pack — and the bar that matters is the
lower one. Otherwise the fallback is a fiction we never look at.

This is the same acceptance test the roadmap states for the reranking
provider: **determinism and a bounded, measured p95, or it does not go on the
read path.** A hosted generative endpoint fails it, and principle 4 wins. What
this document adds is that the query embedding faces the identical test, and
that the choice of embedding model in *Open* below is therefore not only an
accuracy question.

## Assembly under a token budget

`budget_tokens` is caller-supplied. The assembler respects it; it does not
approximate it (`docs/08-mcp-server.md`). Roadmap exit criterion 1 makes that
a gate rather than a measurement.

**Selection is MMR, λ ≈ 0.7.** Greedily, until the budget is exhausted, pick
the atom maximising:

```
λ · rel(a)  −  (1 − λ) · max_{s ∈ selected} sim(a, s)
```

where `rel` is the reranked score and `sim` is cosine over the atom embeddings
already fetched for generator 1 — no second round trip, and no additional
model call.

**Why diversity is not a nicety here.** Deduplication merges above cosine 0.93
and treats below 0.80 as distinct, with an LLM judge only in the band between
(`docs/00-handoff.md`). Atoms in that band that the judge called distinct stay
in the corpus, genuinely different and textually close. A pure relevance
ordering will spend an entire budget on five phrasings of one convention and
report a full pack. The budget is the scarce resource in this system, and
paying it twice for one fact is the specific failure MMR is here to prevent.
λ ≈ 0.7 keeps relevance dominant; like every other constant here it is a
default awaiting a corpus.

**Counting tokens without a tokenizer.** There is no single true token count:
the pack is consumed by Claude, Cursor, Codex and Gemini, whose tokenizers
disagree. So the assembler counts a **conservative upper bound** and packs
against that. Overshoot is then impossible for any client, and the reported
`budget_tokens_used` is an upper bound rather than a measurement — stated in
the response rather than hidden, the same way `packages/mcp/src/budget.test.ts`
states its four-characters-per-token approximation instead of pretending to a
precision it does not have. The bound is computed over the *serialised* pack,
not over the sum of statement lengths, because the envelope and the provenance
fields cost tokens too.

**Where assembly runs.** Server side. Phase 0 put the caps in the MCP package
— `envelope()` and `STATUS_SCAN_LIMIT` — with the comment that the token
budget is the MCP server's problem, and for a list the API does not paginate
that was right. `context` is different: MMR needs the vectors, the vectors are
in the database, and the MCP server does not talk to Postgres
(`docs/03-architecture.md`). So the MCP tool passes `budget_tokens` through
and the assembler runs behind the API, in `core`, over rows fetched by `db`.

**What a packed atom carries.** `atom_id`, `statement`, `kind`, and a
provenance reference of the form `document path#section` — not the full
`source_quote`. Provenance is surfaced, which is what
`docs/02-principles.md` (13) requires of an instruction channel, and the full
verbatim quote is one `read` call away for the agent that wants to check it.
The trade is explicit: quotes are long, the budget is scarce, and a pack that
spends half its tokens on quotations nobody reads has bought nothing. `read`
exists for the full-fidelity case and returns the quote and the section always
(`docs/08-mcp-server.md`).

**Ordering is part of the contract.** After selection, the pack is ordered
`constraint`, then `convention`, then `decision` — deterministically, not by
score. Attention is positional, and the cost of an agent missing a constraint
is higher than the cost of it missing a decision. This is the cheapest
decision in the document to reverse, since the packer is a pure function, and
phase 2's evaluation can measure whether the ordering matters at all.

## Truncation

`docs/08-mcp-server.md` makes `truncated` mandatory and forbids inferring it
from `returned < total`. Roadmap exit criterion 2 requires a test on a case
where `returned == total` and results were dropped upstream. Retrieval is
where that case comes from — in four places.

| Where | What is dropped |
| --- | --- |
| Each generator's `limit $n` | everything below the per-generator candidate cap |
| The fused list's `limit $m` | everything the reranker never sees |
| MMR selection | everything that did not fit the budget |
| HNSW itself | whatever the graph traversal did not reach |

The fourth is the one that changes how the flag has to work. An approximate
index is approximate: `ef_search` bounds the traversal, so the vector
generator's "top 50" is not guaranteed to be the true top 50, and no amount of
counting rows will reveal it. The honest answer to *"did you see everything?"*
is structurally **no**, always.

Two consequences.

- `truncated` is set by whichever stage dropped something and propagated
  upward. It is never recomputed at the boundary from `returned` and `total`,
  because by then the information is gone.
- `total` in a `context` response means *candidates that survived fusion*, not
  atoms that could have matched — a number nobody can compute. Documented
  here because a number whose meaning is ambiguous is worse than no number:
  an agent that reads `total: 47` as "there are 47 relevant atoms" reasons
  from a fact that was never claimed.

And the flag must stay informative. A small project with thirty atoms and a
generous budget drops nothing, and `truncated` is then `false`. It is not set
defensively. A flag that is always true carries no information and the agent
learns to ignore it, which costs us the one case where it mattered.

## The contracts

**Token budget.** A gate. The assembled pack is at or under `budget_tokens`
for every query in the corpus, tested, with the conservative counting above.

**p95 latency.** A contract whose value is **not yet chosen** — it is Open in
`docs/14-roadmap.md` and this document cannot choose it before phase 1
produces a corpus to measure against. What is settled is the shape: a single
number, written into the repository, enforced by a test, measured end to end
from the MCP tool call rather than from the SQL, because the tool call is what
the user experiences. It is apportioned across the stages *before* the
reranker is selected, per condition 4 above.

No latency, accuracy or cost figure appears anywhere in this document, because
none has been measured.

## Tenancy, and the one place it interacts badly with ANN

Retrieval runs inside `withActor` like every other query
(`docs/03-architecture.md`), so RLS policies filter candidates exactly as they
filter CRUD. Nothing about vector search changes the tenancy model.

It does change the *behaviour* of the tenancy model, in a way worth writing
down before someone meets it in production. An HNSW scan visits a bounded
number of neighbours and the policy filters afterwards. For a tenant holding a
small share of a large table, the traversal can return `ef_search` rows that
all belong to other organisations, the policy removes every one, and the query
returns nothing — with matching rows sitting in the table. No error, no
warning, correct-looking behaviour, no results. That is the same shape of
failure as the superuser case in `docs/03-architecture.md`: a failure that
looks like health.

The mitigation to evaluate is pgvector's iterative index scans, which widen
the search when the filter removes too much, and which is why the extension
*version* joins the startup assertion above. Phase 2 measures this on a
multi-tenant fixture with a deliberately lopsided row distribution. It does
not assume it away, and it does not discover it at a customer.

## Degradation

*"The context pack informs the work; it never gates it. When Standfast is empty or
unreachable, the agent proceeds on its own judgment"* (`docs/01-thesis.md`).

Retrieval returns an empty pack rather than an error wherever an empty pack is
the truthful answer: no canonical atoms, no candidates above threshold, a
budget too small for even one atom. An empty pack is a valid response and the
agent carries on. The failures that do surface as errors are the ones where
saying nothing would be a lie — an unreachable database, an expired
credential.

Skipped stages are reported, never inferred, per condition 5.

## Considered and declined

Recorded so each question is asked once.

- **One retriever instead of four.** Whichever is chosen has one systematic
  failure class, and the user finds it within a week.
- **Score normalisation instead of RRF.** Needs per-generator distributions
  that move with the corpus; a recalibration job that degrades silently
  between runs.
- **Learned fusion weights, or learning-to-rank.** Needs the labelled corpus
  we do not have (`docs/02-principles.md`, 10). Revisit when phase 1's
  evaluation set exists and is large enough to hold out.
- **A generative LLM as reranker, or an LLM writing the pack.** Unbounded
  latency, non-reproducible output, per-session cost. Fails every condition
  in *Two model calls, named*, and is the thing principle 4 was written about.
- **Model-based query expansion.** A model call before the query is still a
  model call on the read path, and is declined for that reason alone.

  Deterministic expansion is not a model call and is admissible — but the
  path-component and case-splitting form is **not currently used**, and the
  reason is worth recording because it is not the reason anyone expects.
  `websearch_to_tsquery` builds a conjunction, so handing generator 2 both
  `packages/db` and its components turns one required lexeme into three:
  the alternatives become obligations, and the generator matches *less*.
  Expansion of that kind only helps a disjunctive query, and this parser has no
  grouping with which to build one. Paths and identifiers are generator 3's
  job, which keeps the string whole.

  Stemming is still used, because `to_tsvector` does it on both sides.
- **A hosted vector database or retrieval SDK.** Forbidden by `CLAUDE.md`, and
  independently wrong: a second copy of customer prose in a second
  access-control system, outside the RLS policies that govern the original.
- **Reranking on the customer's machine.** It would keep the query local, and
  it ships model weights to every client and moves a version we must pin into
  a process we do not control (`docs/02-principles.md`, 12). The query has to
  cross the wire for retrieval to happen at all, so the privacy gain is
  smaller than it looks.
- **Caching packs by file path.** The key would need the query, the budget,
  the atom-set version and the reranker version; get it wrong and a stale pack
  is a wrong pack that looks right. Revisit when the p95 number exists and
  says we need it — not before, because a cache added before a measurement is
  a correctness risk taken for an unknown gain.
- **Indexing document sections as a second retrieval unit for `context`.**
  Tempting: sections carry more context than a statement. Declined because it
  puts unratified prose into an unprompted injection and blurs the projection
  invariant. `search` already returns atoms with the document they project
  from, which is a join, not a second retrieval unit.
- **Returning the full `source_quote` in every packed atom.** The budget is
  the scarce resource; `read` exists.
- **Exposing provisional atoms through `context` behind an explicit flag.**
  The argument for is that a solo user who is also the ratifier may reasonably
  want their own pending work back. Declined in `docs/15-ratification.md`,
  which owns the loop: that configuration — proposer and ratifier are the same
  person — is the one where the gate is easiest to stop noticing, and a
  provisional atom arriving in a pack looks like every other atom in a surface
  that has no ratifier to name. Pending work has a home, and it is the queue.

## Open

- ~~**The default embedding model.**~~ **Closed: voyage-3**, in
  `docs/14-roadmap.md`, which owns the decision and records the reasoning —
  native 1024, so the column needs no truncation and no Matryoshka assumption,
  and a 32,000-token input limit that leaves the section window free to be
  chosen on extraction grounds. OpenAI's `text-embedding-3-large` reaches 1024
  only by truncating, and its 8,191-token limit would have been the binding
  constraint on the window.

  What that decision did not buy is recorded there too: voyage-3 is hosted
  only, so `docs/13-threat-model.md`'s Egress rule 4 stayed aspirational while
  it was the only adapter. `packages/worker/src/adapters/bge.ts` is the second
  one — `bge-m3`, natively 1024, over an OpenAI-compatible endpoint an operator
  runs themselves. **The adapter exists; the benchmark that would justify
  choosing it does not**, and the roadmap keeps that open rather than letting
  the existence of code close a question about quality.

  The constraint on how either gets used is unchanged: the query embedding is a
  read-path model call, so it must meet the five conditions above.
- **The reranking provider.** Still open, as in `docs/00-handoff.md`. The gate
  is stated above and in `docs/14-roadmap.md`; the provider is not chosen.
- **The p95 number.** Owned jointly with `docs/14-roadmap.md`, unchosen, and
  unchoosable until a corpus exists.
- **Candidate caps.** The per-generator `n` and the reranker's `N` are
  unknown. Both trade recall against latency and neither can be picked before
  the latency is measured.
- **HNSW parameters** (`m`, `ef_construction`, `ef_search`) — fixed in the
  migration, or tunable per deployment. Tunable means a customer can quietly
  change retrieval quality; fixed means we cannot help a customer whose corpus
  is unusual.
- **Whether the envelope should carry a truncation reason.** "Budget" and
  "candidate cap" call for opposite responses from the agent — ask for more
  budget, or narrow the query — and it cannot currently tell which happened.
  Left open rather than decided because the envelope in
  `docs/08-mcp-server.md` is a settled contract and every field in it costs
  tokens in every response of every session.

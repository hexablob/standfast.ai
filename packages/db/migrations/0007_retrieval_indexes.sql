-- Retrieval indexes. Hand-written: drizzle-kit does not emit HNSW, does not
-- emit a generated tsvector column, and does not emit an expression index over
-- a concatenation, which is three of the four things this migration is.
--
-- This is phase 2's schema half (docs/06-retrieval.md). It adds no table and no
-- policy: retrieval reads atoms, and atoms have been RLS-forced and policied
-- since 0000. What it adds is the three indexes the four candidate generators
-- need, and one column to hold the lexical vector.
--
-- Nothing here calls a model.

-- ─── Generator 2: lexical full text ──────────────────────────────────────────
--
-- tsvector over statement and source quote, which is what docs/06-retrieval.md
-- names. Generated and STORED rather than maintained by a trigger: the column
-- cannot drift from the row, and there is no write path that could forget it.
--
-- The regconfig is spelled out. `to_tsvector(text)` reads
-- default_text_search_config, which is per-session and therefore not immutable,
-- and a generated column may only use immutable expressions — so the one-arg
-- form is not merely worse here, it is rejected. Naming 'english' also means a
-- deployment that changes its session default does not silently re-tokenise
-- every atom it writes afterwards, which would make two halves of one corpus
-- rank against different vocabularies.
--
-- **Unweighted, deliberately.** setweight() over statement above source_quote
-- is the obvious refinement and ts_rank_cd would honour it. It is not applied,
-- because choosing how much more a statement counts than the quote it came from
-- is a tuning decision, and docs/02-principles.md (10) forbids tuning a
-- threshold without a labelled corpus. Phase 2 exit criterion 5 is where that
-- gets decided, on evidence.
ALTER TABLE "atoms"
	ADD COLUMN "search_vector" tsvector
	GENERATED ALWAYS AS (
		to_tsvector('english', "statement" || ' ' || "source_quote")
	) STORED;--> statement-breakpoint

CREATE INDEX "atoms_search_vector_idx"
	ON "atoms" USING gin ("search_vector");--> statement-breakpoint

-- ─── Generator 3: trigram, for identifiers and paths ─────────────────────────
--
-- The expression is repeated verbatim from the query that uses it. An
-- expression index is only consulted when the planner matches the expression
-- exactly, so a query that concatenates in a different order — or with a
-- different separator — gets a sequential scan, correct results, and a latency
-- profile nobody notices until the corpus grows. Stated here because the two
-- copies must be edited together: packages/db/src/repositories/retrieval.ts is
-- the other one.
--
-- Trigrams rather than tokens because tokenisation destroys exactly the strings
-- this generator exists for. A tsvector sees `packages`, `db`, `src` and loses
-- that they were one path; `gin_trgm_ops` matches on substrings, so
-- `schema/rls` still finds an atom naming `packages/db/src/schema`.
CREATE INDEX "atoms_trigram_idx"
	ON "atoms" USING gin (("statement" || ' ' || "source_quote") gin_trgm_ops);--> statement-breakpoint

-- ─── Generator 1: dense vector ───────────────────────────────────────────────
--
-- HNSW with cosine ops, because docs/05-extraction.md's dedup bands are stated
-- in cosine similarity and packages/core/src/similarity.ts computes it. Mixing
-- operator classes between the write path and the read path would put two
-- different notions of "close" in one system.
--
-- **On the parameters, and the open question they belong to.**
-- docs/14-roadmap.md leaves `m`, `ef_construction` and `ef_search` open —
-- "fixed in the migration, or tunable per deployment". That question splits
-- along a line the mechanism itself draws, and this migration follows the line
-- rather than pre-empting the decision:
--
--   * `m` and `ef_construction` are build parameters. They are properties of
--     the graph on disk, so they are fixed here by construction; making them
--     per-deployment would mean a REINDEX, not a setting.
--   * `ef_search` is a per-query GUC. It is set by the retrieval query, not
--     here, and whether an operator may raise it is still open.
--
-- The values are pgvector's own defaults, written out rather than left implicit
-- so that a later change is a visible diff. They are defaults, not
-- measurements: phase 2 exit criterion 5 requires the constants in use to be
-- the recalibrated ones, and no corpus has been measured yet.
CREATE INDEX "atoms_embedding_hnsw_idx"
	ON "atoms" USING hnsw ("embedding" vector_cosine_ops)
	WITH (m = 16, ef_construction = 64);--> statement-breakpoint

-- ─── Generator 4: structural, the generator with no query ────────────────────
--
-- The SessionStart hook fires with a project and no query, and generator 4
-- answers it alone. It is the highest-frequency and most latency-sensitive call
-- in the system and the one with the least machinery in it, so it gets an index
-- shaped exactly like its access path rather than sharing a general one.
--
-- Partial on canonical, because that is the only status this generator returns:
-- docs/06-retrieval.md declines exposing provisional atoms through `context`,
-- and docs/15-ratification.md owns why. A partial index also stays small as the
-- provisional queue grows, which is the part of the table that grows fastest.
CREATE INDEX "atoms_structural_idx"
	ON "atoms" USING btree ("project_id", "kind", "created_at" DESC)
	WHERE status = 'canonical';--> statement-breakpoint

-- Supersession chains, which generator 4 walks so that a pack never contains an
-- atom whose successor was left out — worse than a pack with neither, because
-- the agent acts on the superseded one.
CREATE INDEX "atoms_superseded_by_idx"
	ON "atoms" USING btree ("superseded_by")
	WHERE superseded_by IS NOT NULL;

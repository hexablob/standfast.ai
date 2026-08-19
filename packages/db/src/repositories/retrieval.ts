import { RRF_K } from "@standfast/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import type { atomKind } from "../schema/enums.js";

/**
 * The four candidate generators and the fusion over them, as one statement.
 *
 * `docs/06-retrieval.md` settles the shape and the reason for it. Four
 * generators because whichever single retriever is chosen has one systematic
 * failure class and the user finds it within a week; RRF because the four
 * produce numbers on incomparable scales; **one statement** because four round
 * trips would multiply tail latency by four under a pooled connection, and the
 * p95 is a contract.
 *
 * Everything here runs inside `withActor` like every other query. RLS policies
 * filter candidates exactly as they filter CRUD — nothing about vector search
 * changes the tenancy model, though it does change its behaviour in one place
 * that {@link setRetrievalGucs} exists for.
 */

export type GeneratorName = "dense" | "lexical" | "trigram" | "structural";

export type RetrievalRequest = {
  readonly projectId: string;
  /** Which generators to run. `search` modes select subsets; `context` runs all four. */
  readonly generators: readonly GeneratorName[];
  /** Null whenever the dense generator is not running, or its embedding was skipped. */
  readonly queryEmbedding: readonly number[] | null;
  /** Prepared by `lexicalQuery` in core. Null when there is no free-text query. */
  readonly lexicalQuery: string | null;
  /** Prepared by `trigramQuery` or `pathQuery` in core. */
  readonly trigramQuery: string | null;
  /** Anchors for generator 4, which has no query at all. */
  readonly documentId: string | null;
  readonly sectionId: string | null;
  /** The per-generator candidate cap, and the cap on the fused list. */
  readonly perGeneratorLimit: number;
  readonly fusedLimit: number;
};

export type RetrievedCandidate = {
  readonly atomId: string;
  readonly statement: string;
  readonly kind: (typeof atomKind.enumValues)[number];
  readonly sourceQuote: string;
  /** `document path#section`, assembled here because both halves are joined here. */
  readonly provenance: string;
  readonly documentId: string;
  readonly sectionId: string;
  readonly embedding: number[] | null;
  /** The fused RRF score. Feeds MMR's relevance term. */
  readonly score: number;
  readonly generators: GeneratorName[];
};

export type RetrievalResult = {
  readonly candidates: RetrievedCandidate[];
  /**
   * Whether any stage dropped something.
   *
   * Computed from the generators' own row counts against their caps, and from
   * the fused list against its own — never from `returned < total` at a
   * boundary, because by then the information is gone
   * (`docs/06-retrieval.md`, *Truncation*).
   */
  readonly truncated: boolean;
  /** Per-generator row counts, for the caller that wants to say which capped. */
  readonly counts: Readonly<Partial<Record<GeneratorName, number>>>;
};

/**
 * Only canonical atoms are ever candidates.
 *
 * `docs/06-retrieval.md` declines exposing provisional atoms through `context`
 * even behind a flag, and `docs/15-ratification.md` owns the argument: when the
 * proposer and the ratifier are the same person, the gate is easiest to stop
 * noticing, and a provisional atom in a pack looks like every other atom in a
 * surface that has no ratifier to name.
 *
 * It also disposes of the supersession-coherence worry for free. A superseded
 * atom has status `superseded`, so it is not canonical, so it cannot reach a
 * pack — the successor cannot be "left out" of a set the predecessor never
 * entered.
 */
const CANONICAL = sql`a."status" = 'canonical'`;

/**
 * The trigram expression, in one place.
 *
 * It must match `atoms_trigram_idx` in migration 0007 character for character
 * in the planner's eyes, or the index is not consulted: correct results, and a
 * latency profile nobody notices until the corpus grows. The migration's
 * comment points back here.
 */
const TRIGRAM_TEXT = sql`(a."statement" || ' ' || a."source_quote")`;

/**
 * Every generator fetches one row more than its cap.
 *
 * The extra row is never returned. It exists so that "was anything dropped?"
 * has an exact answer instead of a guess: a generator that comes back with
 * exactly `n` rows might have had exactly `n` to give, and reporting that as
 * truncated is a false positive. `docs/06-retrieval.md` (*Truncation*) requires
 * the flag to stay informative — "a small project with thirty atoms and a
 * generous budget drops nothing, and `truncated` is then false" — and a flag
 * that is always true for a project holding exactly fifty canonical atoms is
 * one the agent learns to ignore.
 *
 * One extra row per generator, four generators, once per request. That is the
 * whole cost of the difference between a signal and a rumour.
 */
function overfetch(limit: number): number {
  return limit + 1;
}

/** Generator 1 — dense vector. The one generator that needs a model call. */
function dense(request: RetrievalRequest): SQL | null {
  if (!request.queryEmbedding) return null;

  // pgvector's text input format. Built here rather than bound as an array,
  // because the driver has no type for it and `::vector` on a text literal is
  // what the extension documents.
  const literal = `[${request.queryEmbedding.join(",")}]`;

  return sql`
    dense as (
      select id, row_number() over (order by distance, id) as rank
      from (
        select a."id", a."embedding" <=> ${literal}::vector as distance
        from "atoms" a
        where a."project_id" = ${request.projectId}
          and ${CANONICAL}
          and a."embedding" is not null
        order by a."embedding" <=> ${literal}::vector
        limit ${overfetch(request.perGeneratorLimit)}
      ) d
    )`;
}

/**
 * Generator 2 — lexical full text.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`, because it never raises on
 * malformed input and a developer's task description is malformed input by the
 * standards of a query language nobody told them about.
 */
function lexical(request: RetrievalRequest): SQL | null {
  if (!request.lexicalQuery) return null;

  return sql`
    lexical as (
      select id, row_number() over (order by score desc, id) as rank
      from (
        select a."id",
               ts_rank_cd(a."search_vector",
                          websearch_to_tsquery('english', ${request.lexicalQuery})) as score
        from "atoms" a
        where a."project_id" = ${request.projectId}
          and ${CANONICAL}
          and a."search_vector" @@ websearch_to_tsquery('english', ${request.lexicalQuery})
        order by score desc
        limit ${overfetch(request.perGeneratorLimit)}
      ) l
    )`;
}

/**
 * Generator 3 — trigram, for identifiers and paths.
 *
 * **`%>` and `word_similarity`, not `%` and `similarity`.** This is the
 * difference between a generator that works and one that silently returns
 * nothing, and it is not visible without a database.
 *
 * `similarity(a, b)` compares two whole strings: it divides the trigrams they
 * share by the trigrams in their union. A query is a handful of words and an
 * atom is a sentence plus the quote it came from, so the union is dominated by
 * text the query never mentioned. Measured on this repository's own fixture,
 * `similarity('core is pure', <a real statement>)` is **0.16** — below the 0.3
 * default threshold, so `%` matches nothing. The generator would return an
 * empty list for exactly the path-and-identifier queries it exists to serve,
 * and nothing would error: fusion would simply proceed on three generators and
 * look healthy.
 *
 * `word_similarity(query, text)` instead finds the best-matching extent of the
 * larger string at word boundaries, which is the semantics
 * `docs/06-retrieval.md` actually describes — "`schema/rls` finds an atom whose
 * statement names `packages/db/src/schema`". The same measurement gives **1.0**.
 *
 * `%>` rather than `<%` because it is the commutator: it puts the indexed
 * expression on the left, which is what lets `atoms_trigram_idx` be consulted.
 * `gin_trgm_ops` supports both.
 */
function trigram(request: RetrievalRequest): SQL | null {
  if (!request.trigramQuery) return null;

  return sql`
    trigram as (
      select id, row_number() over (order by score desc, id) as rank
      from (
        select a."id",
               word_similarity(${request.trigramQuery}, ${TRIGRAM_TEXT}) as score
        from "atoms" a
        where a."project_id" = ${request.projectId}
          and ${CANONICAL}
          and ${TRIGRAM_TEXT} %> ${request.trigramQuery}
        order by score desc
        limit ${overfetch(request.perGeneratorLimit)}
      ) t
    )`;
}

/**
 * Generator 4 — structural, the generator with no query.
 *
 * Graph proximity and a prior, no free-text scoring at all: the section the
 * request named, then its document, then the project; within each, constraints
 * before conventions before decisions, then most recent first.
 *
 * **This is the one that makes session start need no model.** The
 * `SessionStart` hook fires with a project and no query, and this answers it
 * alone — from a btree and a sort, with nothing to embed and nothing to rerank.
 * The highest-frequency and most latency-sensitive call in the system has the
 * least machinery in it, and that is the part of the design worth protecting
 * when the others are tuned.
 */
function structural(request: RetrievalRequest): SQL {
  const proximity = sql`
    case
      when ${request.sectionId}::uuid is not null and a."section_id" = ${request.sectionId}::uuid then 0
      when ${request.documentId}::uuid is not null and a."document_id" = ${request.documentId}::uuid then 1
      else 2
    end`;

  // The same order the packer presents in, applied here as a prior rather than
  // as a score. A constraint is more likely to be worth an agent's budget than
  // a decision, whatever else the request said.
  const kindPrior = sql`
    case a."kind" when 'constraint' then 0 when 'convention' then 1 else 2 end`;

  return sql`
    structural as (
      select id, row_number() over (order by proximity, kind_prior, created_at desc, id) as rank
      from (
        select a."id",
               ${proximity} as proximity,
               ${kindPrior} as kind_prior,
               a."created_at"
        from "atoms" a
        where a."project_id" = ${request.projectId}
          and ${CANONICAL}
        order by proximity, kind_prior, a."created_at" desc
        limit ${overfetch(request.perGeneratorLimit)}
      ) s
    )`;
}

const BUILDERS: Record<
  GeneratorName,
  (request: RetrievalRequest) => SQL | null
> = { dense, lexical, trigram, structural };

/**
 * One row as Postgres hands it back.
 *
 * The per-generator counts arrive as `dense_n`, `lexical_n` and so on — named
 * dynamically, because which generators ran is a property of the request. Hence
 * the index signature, and hence the narrow union on its value: everything read
 * through it is passed to `Number`.
 */
type CandidateRow = {
  atom_id: string;
  statement: string;
  kind: (typeof atomKind.enumValues)[number];
  source_quote: string;
  document_id: string;
  section_id: string;
  document_path: string;
  heading_path: string[] | null;
  embedding: string | null;
  score: number;
  generators: GeneratorName[] | null;
  fused_n: string;
} & Record<string, unknown>;

/**
 * Sets the two GUCs vector search reads, for this transaction only.
 *
 * A separate statement, and it has to be: a GUC cannot be set and read by the
 * same statement, because planning happens once and before execution. That is
 * the one round trip `docs/06-retrieval.md`'s "one statement" rule does not
 * cover, and it is cheap — no planning, no rows.
 *
 * **`hnsw.iterative_scan` is the tenancy mitigation, not a performance knob.**
 * An HNSW scan visits a bounded number of neighbours and the RLS policy filters
 * *afterwards*. For a tenant holding a small share of a large table, the
 * traversal can return `ef_search` rows that all belong to other organisations,
 * the policy removes every one, and the query returns nothing — with matching
 * rows sitting in the table. No error, no warning, no results: a failure that
 * looks like health. Iterative scans widen the search when the filter removes
 * too much, which is why the extension *version* is asserted at start-up rather
 * than assumed.
 *
 * `relaxed_order` rather than `strict_order` because fusion discards the
 * generator's scores and keeps only its ranking, and RRF is not sensitive to a
 * near-tie swapping places — where strict ordering would cost latency to
 * guarantee something the next stage throws away.
 */
export async function setRetrievalGucs(
  db: Db,
  options: { efSearch: number; iterativeScan: boolean },
): Promise<void> {
  await db.execute(sql`
    select set_config('hnsw.ef_search', ${String(options.efSearch)}, true),
           set_config('hnsw.iterative_scan',
                      ${options.iterativeScan ? "relaxed_order" : "off"}, true)`);
}

/**
 * Runs the active generators and fuses them, in one statement.
 *
 * Returns candidates in fused order, each carrying what assembly needs — the
 * embedding included, because MMR's diversity term is cosine over the vectors
 * generator 1 already fetched and a second round trip for them would be a
 * second round trip for nothing.
 */
export async function retrieveCandidates(
  db: Db,
  request: RetrievalRequest,
): Promise<RetrievalResult> {
  const active: GeneratorName[] = [];
  const ctes: SQL[] = [];

  for (const name of request.generators) {
    const builder = BUILDERS[name];
    const cte = builder(request);
    // A generator whose input is missing does not run and is not an error: the
    // dense one drops out when the query embedding was skipped, and the fused
    // order degrades rather than the request failing.
    if (!cte) continue;
    active.push(name);
    ctes.push(cte);
  }

  if (active.length === 0) {
    return { candidates: [], truncated: false, counts: {} };
  }

  // The overfetched row is filtered out here rather than in each generator, so
  // that the CTE still holds it for `stats` to count.
  const unions = sql.join(
    active.map(
      (name) =>
        sql`select id, rank, ${name}::text as generator
            from ${sql.identifier(name)}
            where rank <= ${request.perGeneratorLimit}`,
    ),
    sql` union all `,
  );

  const counts = sql.join(
    active.map(
      (name) =>
        sql`(select count(*) from ${sql.identifier(name)}) as ${sql.identifier(`${name}_n`)}`,
    ),
    sql`, `,
  );

  const result = await db.execute<CandidateRow>(sql`
    with
    ${sql.join(ctes, sql`,`)},
    all_ranks as (${unions}),
    fused as (
      select id,
             sum(1.0 / (${RRF_K} + rank)) as score,
             array_agg(generator order by generator) as generators
      from all_ranks
      group by id
      order by score desc, id
      limit ${overfetch(request.fusedLimit)}
    ),
    stats as (select ${counts}, (select count(*) from fused) as fused_n)
    select f.id as atom_id,
           f.score::float8 as score,
           f.generators,
           a."statement",
           a."kind",
           a."source_quote",
           a."document_id",
           a."section_id",
           a."embedding"::text as embedding,
           d."path" as document_path,
           s."heading_path",
           stats.*
    from fused f
    join "atoms" a on a."id" = f.id
    join "documents" d on d."id" = a."document_id"
    join "document_sections" s on s."id" = a."section_id"
    cross join stats
    order by f.score desc, f.id
    limit ${request.fusedLimit}`);

  const list = result.rows;
  const first = list[0];

  const perGenerator: Partial<Record<GeneratorName, number>> = {};
  let truncated = false;

  if (first) {
    for (const name of active) {
      const fetched = Number(first[`${name}_n`] ?? 0);
      // The overfetched row is what makes this exact. `fetched` runs to
      // `limit + 1`, so strictly greater means there was genuinely more than
      // the cap — never merely that the cap was reached.
      truncated ||= fetched > request.perGeneratorLimit;
      perGenerator[name] = Math.min(fetched, request.perGeneratorLimit);
    }
    truncated ||= Number(first["fused_n"] ?? 0) > request.fusedLimit;

    // The residual this cannot see, documented rather than flagged: an
    // approximate index may not have reached the true top n even when it
    // returned fewer than the cap. Setting the flag for that would make it
    // permanently true on every HNSW query, which is the failure the exactness
    // above exists to avoid.
  }

  return {
    candidates: list.map((row) => ({
      atomId: row.atom_id,
      statement: row.statement,
      kind: row.kind,
      sourceQuote: row.source_quote,
      documentId: row.document_id,
      sectionId: row.section_id,
      provenance: `${row.document_path}#${(row.heading_path ?? []).join(" › ")}`,
      embedding: parseVector(row.embedding),
      score: Number(row.score),
      generators: row.generators ?? [],
    })),
    truncated,
    counts: perGenerator,
  };
}

/**
 * pgvector hands back `[1,2,3]` as text. Parsed here rather than by the driver,
 * which has no type for it.
 */
function parseVector(raw: string | null): number[] | null {
  if (!raw) return null;
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.length === 0) return null;
  return inner.split(",").map(Number);
}

import {
  assemblePack,
  type EgressEntry,
  lexicalQuery,
  type Pack,
  type PackCandidate,
  type PackKind,
  pathQuery,
  trigramQuery,
} from "@standfast/core";
import {
  type Db,
  type GeneratorName,
  type RetrievedCandidate,
  recordEgress,
  retrieveCandidates,
  setRetrievalGucs,
} from "@standfast/db";

/**
 * The read path, from a request to a pack.
 *
 * `docs/06-retrieval.md` names two model calls and no others: embedding the
 * caller's query, and the cross-encoder reranker. Both are pinned and bounded,
 * neither generates text, and `docs/02-principles.md` (4) admits exactly that
 * pair. Everything else on this path — query preparation, fusion, MMR,
 * packing — is deterministic string and arithmetic work.
 *
 * **Both model calls are optional here, and that is the design rather than a
 * shortcut.** Condition 5: if a model call exceeds its deadline or is
 * unavailable, retrieval proceeds without it and says so. A build with neither
 * port bound opens no socket at all, which is what lets the whole read path run
 * in CI with no network and no secrets — the same property phase 1c bought for
 * extraction.
 */

/**
 * Embeds one query. The read path's first model call.
 *
 * Deliberately not the `Embedder` port the worker uses: that one batches,
 * because a four-hundred-section document would otherwise be four hundred round
 * trips. A query is one string, and a batching interface here would invite a
 * caller to think retrieval could amortise something it cannot.
 */
export type QueryEmbedder = {
  readonly id: string;
  readonly egress: EgressEntry | null;
  embed(text: string, signal: AbortSignal): Promise<readonly number[]>;
};

/**
 * Reorders the top N of the fused list. The read path's second model call.
 *
 * **No provider is bound.** `docs/06-retrieval.md` condition 2 requires a model
 * operated by us in the region of the database — not a third-party hosted
 * endpoint, whose latency would be somebody else's SLO and whose weights change
 * without a version bump. That infrastructure does not exist, and
 * `docs/14-roadmap.md` leaves the provider Open with an acceptance test:
 * determinism and a bounded, measured p95, or it does not go on the read path.
 *
 * So the stage exists, is skippable, and is skipped. That is not the same as
 * omitting it: the seam is here, the skip is reported, and
 * `docs/12-evaluation.md` can measure the reranked pack and the fused-only pack
 * as two regimes — which the same document requires, because a precision bar
 * met only with the reranker is a bar that fails whenever the reranker is slow.
 */
export type Reranker = {
  readonly id: string;
  readonly egress: EgressEntry | null;
  rerank(
    query: string,
    candidates: readonly { id: string; text: string }[],
    signal: AbortSignal,
  ): Promise<readonly { id: string; score: number }[]>;
};

export type RetrievalPorts = {
  readonly queryEmbedder: QueryEmbedder | null;
  readonly reranker: Reranker | null;
};

/** A build with neither model call bound. Opens no socket; skips both stages. */
export const NO_RETRIEVAL_PORTS: RetrievalPorts = {
  queryEmbedder: null,
  reranker: null,
};

/**
 * The candidate caps and the default budget.
 *
 * Every number here is a default awaiting a corpus, in the same sense as
 * `RRF_K` and `MMR_LAMBDA`. `docs/06-retrieval.md` lists candidate caps under
 * *Open*: the per-generator `n` and the reranker's `N` both trade recall
 * against latency, and neither can be picked before the latency is measured.
 * `docs/14-roadmap.md` phase 2 exit criterion 5 is where they stop being
 * guesses. Written here in one place so that recalibration is one diff.
 */
export const RETRIEVAL_DEFAULTS = {
  perGeneratorLimit: 50,
  fusedLimit: 200,
  rerankTopN: 50,
  budgetTokens: 2000,
  /** pgvector's own default. Widened by iterative scan when RLS filters hard. */
  efSearch: 40,
} as const;

export type ContextRequest = {
  readonly orgId: string;
  readonly projectId: string;
  readonly scope: "file" | "task" | "project";
  readonly query: string | null;
  readonly paths: readonly string[];
  readonly documentId: string | null;
  readonly sectionId: string | null;
  readonly budgetTokens: number;
};

export type SearchRequest = {
  readonly orgId: string;
  readonly projectId: string;
  readonly query: string;
  readonly mode: "lexical" | "semantic" | "hybrid";
  readonly limit: number;
};

/**
 * Which generators each call runs, from `docs/06-retrieval.md` (*How the modes
 * map*). One pipeline, two terminations.
 */
function generatorsFor(
  call:
    | { kind: "context"; scope: ContextRequest["scope"] }
    | {
        kind: "search";
        mode: SearchRequest["mode"];
      },
): GeneratorName[] {
  if (call.kind === "context")
    return ["dense", "lexical", "trigram", "structural"];

  switch (call.mode) {
    case "lexical":
      return ["lexical", "trigram"];
    case "semantic":
      return ["dense"];
    default:
      return ["dense", "lexical", "trigram", "structural"];
  }
}

/**
 * Embeds the query, or reports that it did not.
 *
 * A failure is not an error. Generator 1 drops out, the other three still
 * answer, and the fused order degrades rather than the request failing — which
 * `docs/06-retrieval.md` calls the availability half of the argument for having
 * four generators at all.
 */
async function embedQuery(
  db: Db,
  ports: RetrievalPorts,
  tenant: { orgId: string; projectId: string },
  text: string | null,
  signal: AbortSignal,
  skipped: string[],
): Promise<readonly number[] | null> {
  if (!text) return null;

  const embedder = ports.queryEmbedder;
  if (!embedder) {
    skipped.push("dense");
    return null;
  }

  // Written before the query leaves, never after. `docs/13-threat-model.md`
  // (*Egress*, rule 3) makes the record the thing that answers "what left, and
  // to whom", and a row written afterwards is a row that is missing exactly
  // when the call failed in an interesting way.
  //
  // A failure to record does not fail the request — it *cancels the call*. The
  // rule that matters is that nothing unrecorded is sent, and skipping the
  // dense generator satisfies it while leaving the other three to answer. The
  // skip is reported, so the caller can tell this apart from a healthy pack.
  if (embedder.egress) {
    try {
      await recordEgress(db, {
        orgId: tenant.orgId,
        projectId: tenant.projectId,
        // No section: this call is about a question, not about stored prose,
        // which is the whole reason it has its own purpose.
        purpose: "query-embedding",
        destination: embedder.egress.origin,
        model: embedder.egress.model,
        inputItems: 1,
        // A size, never a sample. The disclosure log must not become a second
        // copy of what it is describing — least of all of the queries.
        inputChars: text.length,
      });
    } catch {
      skipped.push("dense");
      return null;
    }
  }

  try {
    return await embedder.embed(text, signal);
  } catch {
    // Swallowed on purpose, and recorded. Silent degradation would mean two
    // ranking regimes an evaluation cannot tell apart.
    skipped.push("dense");
    return null;
  }
}

async function rerank(
  ports: RetrievalPorts,
  query: string | null,
  candidates: RetrievedCandidate[],
  signal: AbortSignal,
  skipped: string[],
): Promise<Map<string, number> | null> {
  if (!ports.reranker || !query || candidates.length === 0) {
    skipped.push("reranker");
    return null;
  }

  try {
    const top = candidates.slice(0, RETRIEVAL_DEFAULTS.rerankTopN);
    const scored = await ports.reranker.rerank(
      query,
      top.map((c) => ({ id: c.atomId, text: c.statement })),
      signal,
    );
    return new Map(scored.map((s) => [s.id, s.score]));
  } catch {
    skipped.push("reranker");
    return null;
  }
}

function toPackCandidate(
  candidate: RetrievedCandidate,
  relevance: number,
): PackCandidate {
  return {
    atomId: candidate.atomId,
    statement: candidate.statement,
    kind: candidate.kind as PackKind,
    provenance: candidate.provenance,
    relevance,
    embedding: candidate.embedding,
  };
}

export type ContextResult = Pack & { readonly skipped: string[] };

/**
 * `context` — the packed termination.
 *
 * Runs all four generators, fuses, reranks if it can, and assembles under the
 * caller's budget. Returns an empty pack rather than an error wherever an empty
 * pack is the truthful answer: no canonical atoms, nothing above threshold, a
 * budget too small for one atom. `docs/01-thesis.md` has the agent proceed on
 * its own judgment, and a pack that errors would stop it.
 */
export async function buildContext(
  db: Db,
  ports: RetrievalPorts,
  request: ContextRequest,
  signal: AbortSignal,
): Promise<ContextResult> {
  const skipped: string[] = [];

  // Under `scope: "file"` there is no free-text query and so no query embedding
  // at all — docs/08-mcp-server.md says so, and it means the highest-frequency
  // shape of this call reaches no model.
  const dense = request.scope === "file" ? null : request.query;
  const embedding = await embedQuery(
    db,
    ports,
    { orgId: request.orgId, projectId: request.projectId },
    dense,
    signal,
    skipped,
  );

  const paths = pathQuery(request.paths);
  const text = request.query ?? "";

  await setRetrievalGucs(db, {
    efSearch: RETRIEVAL_DEFAULTS.efSearch,
    iterativeScan: true,
  });

  const found = await retrieveCandidates(db, {
    projectId: request.projectId,
    generators: generatorsFor({ kind: "context", scope: request.scope }),
    queryEmbedding: embedding,
    lexicalQuery: text ? lexicalQuery(text) : null,
    // A file-scoped call has no query but does have paths, and trigram is the
    // generator that matches a path as text. Falling back this way is what
    // makes `scope: "file"` return anything at all.
    trigramQuery: paths || (text ? trigramQuery(text) : null) || null,
    documentId: request.documentId,
    sectionId: request.sectionId,
    perGeneratorLimit: RETRIEVAL_DEFAULTS.perGeneratorLimit,
    fusedLimit: RETRIEVAL_DEFAULTS.fusedLimit,
  });

  const scores = await rerank(
    ports,
    request.query,
    found.candidates,
    signal,
    skipped,
  );

  const pack = assemblePack({
    candidates: found.candidates.map((candidate) =>
      toPackCandidate(
        candidate,
        scores?.get(candidate.atomId) ?? candidate.score,
      ),
    ),
    budgetTokens: request.budgetTokens,
    upstreamTruncated: found.truncated,
    skipped,
  });

  return { ...pack, skipped };
}

export type SearchHit = {
  readonly atomId: string;
  readonly statement: string;
  readonly kind: PackKind;
  readonly documentId: string;
  readonly sectionId: string;
  readonly provenance: string;
  readonly score: number;
};

export type SearchResult = {
  readonly items: SearchHit[];
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly skipped: string[];
};

/**
 * `search` — the ranked-list termination.
 *
 * The same pipeline as `context` up to fusion, stopping before assembly: no
 * MMR, no budget, no packing. `docs/06-retrieval.md` has one pipeline with two
 * terminations, and this is the other one.
 */
export async function runSearch(
  db: Db,
  ports: RetrievalPorts,
  request: SearchRequest,
  signal: AbortSignal,
): Promise<SearchResult> {
  const skipped: string[] = [];
  const generators = generatorsFor({ kind: "search", mode: request.mode });

  const embedding = generators.includes("dense")
    ? await embedQuery(
        db,
        ports,
        { orgId: request.orgId, projectId: request.projectId },
        request.query,
        signal,
        skipped,
      )
    : null;

  await setRetrievalGucs(db, {
    efSearch: RETRIEVAL_DEFAULTS.efSearch,
    iterativeScan: true,
  });

  const found = await retrieveCandidates(db, {
    projectId: request.projectId,
    generators,
    queryEmbedding: embedding,
    lexicalQuery: generators.includes("lexical")
      ? lexicalQuery(request.query)
      : null,
    trigramQuery: generators.includes("trigram")
      ? trigramQuery(request.query)
      : null,
    documentId: null,
    sectionId: null,
    perGeneratorLimit: RETRIEVAL_DEFAULTS.perGeneratorLimit,
    fusedLimit: RETRIEVAL_DEFAULTS.fusedLimit,
  });

  const scores = await rerank(
    ports,
    request.query,
    found.candidates,
    signal,
    skipped,
  );

  const ranked = [...found.candidates].sort(
    (a, b) =>
      (scores?.get(b.atomId) ?? b.score) - (scores?.get(a.atomId) ?? a.score) ||
      (a.atomId < b.atomId ? -1 : 1),
  );

  const kept = ranked.slice(0, request.limit);

  return {
    items: kept.map((candidate) => ({
      atomId: candidate.atomId,
      statement: candidate.statement,
      kind: candidate.kind as PackKind,
      documentId: candidate.documentId,
      sectionId: candidate.sectionId,
      provenance: candidate.provenance,
      score: scores?.get(candidate.atomId) ?? candidate.score,
    })),
    total: found.candidates.length,
    returned: kept.length,
    // Propagated from whichever stage dropped something, OR-ed with this
    // stage's own cut. Never recomputed from `returned < total`.
    truncated: found.truncated || kept.length < ranked.length,
    skipped,
  };
}

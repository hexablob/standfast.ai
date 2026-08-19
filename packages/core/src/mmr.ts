import { cosineSimilarity } from "./similarity.js";

/**
 * Maximal Marginal Relevance selection, λ ≈ 0.7.
 *
 * `docs/06-retrieval.md` (*Assembly under a token budget*): greedily, until the
 * budget is exhausted, pick the atom maximising
 *
 * ```
 * λ · rel(a)  −  (1 − λ) · max_{s ∈ selected} sim(a, s)
 * ```
 *
 * where `rel` is the reranked score and `sim` is cosine over the atom
 * embeddings already fetched for generator 1 — no second round trip and no
 * additional model call.
 *
 * **Why diversity is not a nicety here.** Deduplication merges above cosine
 * 0.93 and treats below 0.80 as distinct, with a judge only in between. Atoms
 * in that band the judge called distinct stay in the corpus, genuinely
 * different and textually close. A pure relevance ordering spends an entire
 * budget on five phrasings of one convention and reports a full pack. The
 * budget is the scarce resource, and paying it twice for one fact is the
 * failure this prevents.
 */

/**
 * Relevance's share of the objective.
 *
 * Keeps relevance dominant. Like every other constant on this path it is a
 * default awaiting a corpus — `docs/14-roadmap.md` phase 2 exit criterion 5
 * forbids shipping the defaults unchanged as though someone had checked them,
 * and `docs/02-principles.md` (10) forbids moving them before the corpus
 * exists. So it stays at 0.7 and it stays labelled.
 */
export const MMR_LAMBDA = 0.7;

export type MmrCandidate = {
  readonly atomId: string;
  /**
   * The reranked score, or the fused RRF score when the reranker was skipped.
   *
   * On whatever scale it arrives; {@link mmrSelect} normalises. Larger is more
   * relevant.
   */
  readonly relevance: number;
  /**
   * The embedding generator 1 already fetched, or null for an atom that has
   * none yet.
   */
  readonly embedding: readonly number[] | null;
};

/**
 * Selects greedily in MMR order, stopping when `fits` refuses everything left.
 *
 * `fits` is how the budget enters: it is asked whether a candidate can be added
 * to what is already selected, and the loop takes the highest-scoring candidate
 * it accepts. Taking the best *among those that fit* — rather than stopping at
 * the first that does not — is the reading of "until the budget is exhausted"
 * that spends the whole budget, and it stays deterministic because the order it
 * walks is total.
 *
 * Returns what was selected, in selection order, and whether anything was left
 * behind. The caller propagates that as `truncated`; it is never recomputed
 * from counts at a boundary, per `docs/06-retrieval.md` (*Truncation*).
 */
export function mmrSelect(
  candidates: readonly MmrCandidate[],
  fits: (candidate: MmrCandidate, selected: readonly MmrCandidate[]) => boolean,
  lambda: number = MMR_LAMBDA,
): { selected: MmrCandidate[]; dropped: number } {
  // Selection runs on normalised relevance; everything handed back to the
  // caller — and to `fits` — is the candidate it passed in, so no downstream
  // stage ever sees a score this function rescaled for its own use.
  const asGiven = new Map(candidates.map((c) => [c.atomId, c]));
  const remaining = new Map(
    normaliseRelevance(candidates).map((c) => [c.atomId, c]),
  );
  const selected: MmrCandidate[] = [];

  while (remaining.size > 0) {
    const ranked = [...remaining.values()]
      .map((candidate) => ({
        candidate,
        score:
          lambda * candidate.relevance -
          (1 - lambda) * maxSimilarity(candidate, selected),
      }))
      // Ties break on atom id so the order is total. An unstable tie-break
      // reads as noise in a precision number and gets blamed on the retriever.
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.candidate.atomId < b.candidate.atomId ? -1 : 1),
      );

    const next = ranked.find(({ candidate }) => {
      const given = asGiven.get(candidate.atomId);
      return given !== undefined && fits(given, selected);
    });
    if (!next) break;

    const given = asGiven.get(next.candidate.atomId);
    if (!given) break;

    remaining.delete(next.candidate.atomId);
    selected.push(given);
  }

  return { selected, dropped: remaining.size };
}

/**
 * The largest cosine similarity between a candidate and anything selected.
 *
 * Clamped at zero from below. A negative cosine would otherwise become a
 * negative penalty and *reward* selecting an atom pointing away from the pack,
 * which is not what the diversity term means.
 *
 * An atom with no embedding scores zero — no penalty. That biases the pack
 * towards including atoms extraction has not embedded yet, which is the safe
 * direction: an atom we cannot compare is not a known duplicate, and excluding
 * it would silently hide knowledge for a reason the agent could never see.
 */
function maxSimilarity(
  candidate: MmrCandidate,
  selected: readonly MmrCandidate[],
): number {
  if (!candidate.embedding) return 0;

  let worst = 0;
  for (const other of selected) {
    if (!other.embedding) continue;
    const similarity = cosineSimilarity(candidate.embedding, other.embedding);
    if (similarity > worst) worst = similarity;
  }
  return worst;
}

/**
 * Rescales relevance to `[0, 1]` across the candidate set.
 *
 * Necessary, and not a contradiction of the argument that sent fusion to RRF.
 * A fused RRF score tops out near `4 / (k + 1)` — about 0.066 at k = 60 — while
 * cosine similarity runs to 1. Subtracting one from the other unscaled makes
 * the diversity term dominate completely, and λ stops meaning anything: the
 * pack would be chosen almost entirely for spread, whatever λ was set to.
 *
 * `docs/06-retrieval.md` declines score normalisation *for fusion*, on the
 * grounds that it needs per-generator distributions that move with the corpus
 * and become a recalibration job that degrades silently. This is a different
 * operation with none of those properties: it is min-max over one request's
 * already-fused candidate set, it reads no corpus statistic, and it is
 * recomputed from scratch on every call. Nothing about it drifts between runs.
 *
 * When every candidate scores the same — one generator, or a perfect tie —
 * everything normalises to 1 and the objective reduces to pure diversity, which
 * is the right behaviour when relevance carries no signal.
 */
function normaliseRelevance(
  candidates: readonly MmrCandidate[],
): MmrCandidate[] {
  const scores = candidates.map((c) => c.relevance);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;

  return candidates.map((candidate) => ({
    ...candidate,
    relevance: span === 0 ? 1 : (candidate.relevance - min) / span,
  }));
}

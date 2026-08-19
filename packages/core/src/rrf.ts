/**
 * Reciprocal Rank Fusion, and the constant the fused query is built around.
 *
 * `docs/06-retrieval.md` (*Fusion: RRF at k=60*) settles both the formula and
 * where it runs:
 *
 * ```
 * score(a) = Σ_g  1 / (k + rank_g(a))          k = 60
 * ```
 *
 * **Fusion runs in SQL, not here.** One statement, one CTE per generator, a
 * `union all` into a grouped sum — because four round trips would multiply tail
 * latency by four under a pooled connection and the p95 is a contract. So this
 * module is not the implementation the read path uses.
 *
 * It is the oracle that implementation is checked against. {@link RRF_K} is
 * interpolated into the query, so the constant has one home; {@link rrfFuse} is
 * a reference the integration suite runs beside the real query over the same
 * fixture, and the two must agree. Two implementations that can drift are a
 * liability unless a test pins them together, which is the only reason this one
 * is allowed to exist.
 *
 * Ranks, not scores, and the reason is in the design document: the four
 * generators produce numbers on incomparable scales, normalising them requires
 * knowing distributions that move as the corpus grows, and RRF keeps only the
 * ordering — comparable by construction.
 */

/**
 * The damping constant.
 *
 * From the original RRF paper, inherited rather than measured. At k = 60 the
 * gap between rank 1 and rank 2 is 1/61 against 1/62 — nearly nothing — while
 * the gap between rank 1 and rank 100 is large, so no single generator
 * dominates the fused order.
 *
 * **A default awaiting a corpus.** `docs/14-roadmap.md` phase 2 exit criterion
 * 5 requires that the constants in use are the recalibrated ones and that the
 * corpus they were calibrated on is committed. Shipping this unchanged would
 * mean nobody checked, so it may not move until that corpus exists —
 * `docs/02-principles.md` (10) is the rule it would otherwise break.
 */
export const RRF_K = 60;

/** One generator's output: atom ids in the order that generator ranked them. */
export type RankedList = readonly string[];

export type FusedAtom = {
  readonly atomId: string;
  readonly score: number;
  /** Which generators returned it. Ordered as the input lists were. */
  readonly generators: readonly string[];
};

/**
 * Fuses ranked lists into one order.
 *
 * Ranks are one-based, so the first element of a list contributes
 * `1 / (k + 1)`. Ties break on atom id, ascending — arbitrary but total, which
 * is what the evaluation harness needs from a ranker whose output it compares
 * across runs. An unstable tie-break shows up as noise in a precision number
 * and gets attributed to the retriever.
 *
 * An atom appearing twice within one generator's list keeps its best rank; a
 * generator that returns duplicates is a bug, and silently summing them would
 * let that bug buy rank.
 */
export function rrfFuse(
  lists: Readonly<Record<string, RankedList>>,
  k: number = RRF_K,
): FusedAtom[] {
  const scores = new Map<string, { score: number; generators: string[] }>();

  for (const [generator, list] of Object.entries(lists)) {
    const seen = new Set<string>();

    for (let index = 0; index < list.length; index++) {
      const atomId = list[index];
      if (atomId === undefined || seen.has(atomId)) continue;
      seen.add(atomId);

      const entry = scores.get(atomId) ?? { score: 0, generators: [] };
      entry.score += 1 / (k + index + 1);
      entry.generators.push(generator);
      scores.set(atomId, entry);
    }
  }

  return [...scores.entries()]
    .map(([atomId, entry]) => ({
      atomId,
      score: entry.score,
      generators: entry.generators,
    }))
    .sort((a, b) => b.score - a.score || (a.atomId < b.atomId ? -1 : 1));
}

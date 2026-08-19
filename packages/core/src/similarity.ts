/**
 * Cosine similarity between two vectors of equal length.
 *
 * Returns a number in `[-1, 1]`, and `0` when either vector has no magnitude —
 * a zero vector has no direction, so no angle to it is meaningful, and `0` is
 * the answer that keeps such a pair out of every band below.
 *
 * **Similarity, not distance.** pgvector's `<=>` operator returns cosine
 * *distance*, so SQL that wants this number computes `1 - (a <=> b)`. Getting
 * the orientation backwards is silent and total: everything merges into the
 * first atom ever written, the corpus stops growing, and nothing errors.
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine similarity needs equal lengths, got ${a.length} and ${b.length}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The deduplication bands, from docs/05-extraction.md.
 *
 * Starting points, to be recalibrated against a corpus of atom pairs a human
 * labelled same-claim or different-claim — which does not exist yet, and which
 * docs/12-evaluation.md insists must not be derived from these numbers. Nothing
 * may move either value before that corpus does.
 */
export const DEDUP_BANDS = {
  /** At or above this, ask the judge. Below it, the candidate is distinct. */
  judgeFrom: 0.8,
  /** At or above this, the candidate is a duplicate and no model is asked. */
  duplicateFrom: 0.93,
} as const;

export type Band = "distinct" | "judge" | "duplicate";

/**
 * Which band a similarity falls in.
 *
 * Both boundaries are inclusive-below, so the bands are `[-1, 0.80)`,
 * `[0.80, 0.93)` and `[0.93, 1]`. Stated once, here, so no call site has to
 * decide whether 0.80 exactly means ask or ignore.
 */
export function bandFor(similarity: number): Band {
  if (similarity >= DEDUP_BANDS.duplicateFrom) return "duplicate";
  if (similarity >= DEDUP_BANDS.judgeFrom) return "judge";
  return "distinct";
}

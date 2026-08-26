/**
 * The distribution of a set of timings, and nothing else.
 *
 * This module deliberately holds no threshold, no bar and no comparison. The
 * p95 latency contract for `context` is Open and **owned by
 * `docs/14-roadmap.md`**, which states the reason a harness must not choose it:
 * "a contract set to whatever the implementation happened to achieve is not a
 * contract". So the latency slice measures and reports; `baselines.json` has
 * four metrics and no latency metric, and that is correct.
 *
 * Pure, so it is unit-tested without a database — `docs/12-evaluation.md`,
 * *Layout*: "src/metrics/ is pure and unit-tested".
 */

/** A summary with no mean in it, on purpose. */
export type Distribution = {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

/**
 * **Nearest-rank**, on the sorted-ascending samples: the p-th percentile is the
 * value at 1-based index `ceil(p / 100 * n)`, clamped to `[1, n]`.
 *
 * Chosen over linear interpolation because every number this reports is then a
 * request that actually happened. An interpolated p95 is a value between two
 * observations, and the first question anyone asks of a tail figure is "which
 * request was that" — a question interpolation cannot answer. It also reads the
 * same way a percentile does in every latency dashboard the reader has seen.
 *
 * The cost is that at small n the percentiles collapse onto the same sample
 * (with n = 2, p90 = p95 = p99 = max). That is honest rather than unfortunate:
 * n is reported alongside, and a tail estimated from twenty samples is not a
 * tail.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    throw new Error("percentile of an empty sample");
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] as number;
}

/** Null rather than a summary of nothing: an empty sample has no distribution. */
export function distribution(samples: readonly number[]): Distribution | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] as number,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] as number,
  };
}

/**
 * Drops the first `warmup` samples.
 *
 * The first calls into a cold process measure things the contract is not about:
 * V8 tiering up through the MCP codec and the Zod validators, the pool
 * establishing its first connection and its TLS handshake, Postgres reading the
 * HNSW index pages off disk into shared buffers, and the query planner seeing
 * each statement for the first time. A p95 is a claim about a warm server
 * answering the millionth request, not the first, so those samples are taken
 * and thrown away rather than not taken — running them is what makes the rest
 * warm.
 *
 * Refuses to trim everything: a warm-up that consumed the whole sample would
 * leave a distribution of nothing and look like a measurement.
 */
export function trimWarmup(
  samples: readonly number[],
  warmup: number,
): readonly number[] {
  if (warmup < 0) {
    throw new Error("warm-up count cannot be negative");
  }
  if (warmup >= samples.length) {
    throw new Error(
      `warm-up of ${warmup} would discard all ${samples.length} sample(s), leaving nothing to report`,
    );
  }
  return samples.slice(warmup);
}

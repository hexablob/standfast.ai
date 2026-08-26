/**
 * The interval that travels beside every proportion this harness reports.
 *
 * `docs/12-evaluation.md` sizes the first corpus by what the team can label
 * blind inside a fixed time-box and then asks whether the resulting confidence
 * interval is narrower than the decisions it has to support. A bare point
 * estimate cannot answer that question, which is the only question the figure
 * was collected to answer: 0.82 over 500 trials and 0.82 over 11 are the same
 * number and different evidence.
 */
export type Interval = { readonly low: number; readonly high: number };

/**
 * Wilson score interval at 95% for a proportion of `successes` in `n` trials.
 *
 * Wilson rather than the normal approximation because the whole reason the
 * interval exists is low counts near zero, which is exactly where the normal
 * approximation collapses to a width of nothing.
 */
export function wilsonInterval(successes: number, n: number): Interval {
  if (n <= 0) {
    throw new Error("a confidence interval over zero trials is not a thing");
  }
  const z = 1.959964; // 95%
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * A proportion and its interval, computed together so that neither can be
 * reported without the other.
 *
 * Both are null at `n === 0`, on the same reasoning the scorers already apply
 * to a bare rate: a proportion of nothing is undefined — not 0, not 1 — and
 * `wilsonInterval` refuses zero trials outright rather than inventing a width.
 * Null is the honest report of an empty denominator, and every caller renders
 * it as `n/a` rather than as a number.
 */
export type Proportion = {
  readonly rate: number | null;
  readonly interval: Interval | null;
};

export function proportion(successes: number, n: number): Proportion {
  return n === 0
    ? { rate: null, interval: null }
    : { rate: successes / n, interval: wilsonInterval(successes, n) };
}

/** `0.812 (95% CI 0.744–0.866)`, or `n/a` when the denominator was zero. */
export function formatProportion(value: Proportion, digits = 3): string {
  if (value.rate === null || value.interval === null) {
    return "n/a";
  }
  return (
    `${value.rate.toFixed(digits)} ` +
    `(95% CI ${value.interval.low.toFixed(digits)}–${value.interval.high.toFixed(digits)})`
  );
}

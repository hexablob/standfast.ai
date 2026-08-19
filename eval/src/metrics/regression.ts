import { z } from "zod";

export const METRICS = [
  "extraction_precision",
  "retrieval_precision_under_budget",
  "reconciliation_false_positive_rate",
  "ratification_throughput",
] as const;
export type Metric = (typeof METRICS)[number];

const BaselineEntry = z.object({
  direction: z.enum(["higher-is-better", "lower-is-better"]),

  /** The bar, once chosen. It tightens on evidence and never loosens. */
  bar: z.number().nullable(),

  /**
   * A hard threshold is checked against the value alone, never against the
   * baseline. A delta rule would let the kill metric walk from 1% to 4.9%
   * across ten individually green pull requests.
   */
  barIsHardThreshold: z.boolean(),

  baseline: z.number().nullable(),

  /**
   * Not zero: these are sampled metrics, and one example flipping on a
   * two-hundred-example corpus is not a regression. Computed from the corpus's
   * measured variance, which is unknown until the corpus exists.
   */
  noiseBand: z.number().nullable(),

  /** The run file that produced the baseline. */
  run: z.string().nullable(),

  note: z.string(),
});

export const Baselines = z.object({
  version: z.literal(1),
  metrics: z.record(z.enum(METRICS), BaselineEntry),
});

export type BaselineEntry = z.infer<typeof BaselineEntry>;
export type Baselines = z.infer<typeof Baselines>;

export type Comparison = {
  /**
   * - `pass`      — inside the noise band.
   * - `regressed` — worse than the baseline by more than the band.
   * - `improved`  — better by more than the band, which **also fails** until
   *                 the baseline is updated in the same diff. A silent
   *                 improvement is an unreviewed change to a number the product
   *                 is judged on, and it is the only cheap way to catch an
   *                 improvement that came from the corpus getting easier.
   * - `below-bar` — a hard threshold was breached, whatever the baseline says.
   * - `ungated`   — no baseline or no noise band. Never a pass.
   */
  status: "pass" | "regressed" | "improved" | "below-bar" | "ungated";
  /** Whether this fails the build. Only `pass` does not. */
  fails: boolean;
  reason: string;
};

function worse(
  value: number,
  than: number,
  direction: BaselineEntry["direction"],
): boolean {
  return direction === "higher-is-better" ? value < than : value > than;
}

export function compareToBaseline(
  value: number,
  entry: BaselineEntry,
): Comparison {
  // First, and independently of everything else. The kill metric fails at 5%
  // whether or not the baseline is 4.9% and whether or not a baseline exists.
  if (entry.barIsHardThreshold && entry.bar !== null) {
    const breached =
      entry.direction === "lower-is-better"
        ? value >= entry.bar
        : value < entry.bar;
    if (breached) {
      return {
        status: "below-bar",
        fails: true,
        reason: `${value} breaches the hard bar of ${entry.bar}`,
      };
    }
  }

  if (entry.baseline === null) {
    return {
      status: "ungated",
      fails: false,
      reason:
        "no committed baseline — this run cannot regress against anything, " +
        "and must not be read as a pass",
    };
  }

  if (entry.noiseBand === null) {
    return {
      status: "ungated",
      fails: false,
      reason:
        "no noise band — the band is computed from the corpus's measured " +
        "variance, and gating without one turns sampling noise into a build " +
        "failure",
    };
  }

  const delta = Math.abs(value - entry.baseline);
  if (delta <= entry.noiseBand) {
    return {
      status: "pass",
      fails: false,
      reason: `${value} is within ${entry.noiseBand} of the baseline ${entry.baseline}`,
    };
  }

  if (worse(value, entry.baseline, entry.direction)) {
    return {
      status: "regressed",
      fails: true,
      reason: `${value} is worse than the baseline ${entry.baseline} by more than ${entry.noiseBand}`,
    };
  }

  return {
    status: "improved",
    fails: true,
    reason:
      `${value} is better than the baseline ${entry.baseline} by more than ` +
      `${entry.noiseBand}. Update eval/baselines.json in the same diff.`,
  };
}

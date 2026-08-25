/**
 * Scoring for the reconciliation false-positive rate — the kill metric.
 *
 * Pure. docs/12-evaluation.md §3 fixes the definitions this implements:
 *
 * - a false positive is a `violated` finding on an edit a human labelled
 *   `no-finding`;
 * - the denominator is **findings emitted with verdict `violated`** — the
 *   notifications a user sees — not edits examined;
 * - `not_applicable` is a retrieval miss and is not counted here;
 * - the false-negative rate is measured and published beside the headline,
 *   never optimised, because the degenerate optimum of a kill metric is
 *   silence;
 * - legitimate drift is labelled `violated` (the finding is correct) and is
 *   still reported apart, because it is the case where the right response is
 *   editing the document.
 */

export const EDIT_SLICES = [
  "seeded-violation",
  "seeded-near-miss",
  "innocent",
  "legitimate-drift",
] as const;
export type EditSlice = (typeof EDIT_SLICES)[number];

export type EditExpectation = {
  readonly id: string;
  readonly slice: EditSlice;
  /** The human verdict: what a correct reconciler does with this edit. */
  readonly expected: "violated" | "no-finding";
};

export type RecordedFinding = {
  readonly edit: string;
  readonly verdict: "honored" | "violated" | "not_applicable" | "unverifiable";
};

export type SliceScore = {
  readonly edits: number;
  readonly emitted: number;
  readonly falsePositives: number;
  readonly misses: number;
};

export type ReconciliationScore = {
  readonly edits: number;
  readonly findings: number;
  /** Findings with verdict `violated` — the denominator. */
  readonly emitted: number;
  readonly falsePositives: number;
  /** falsePositives / emitted. Null when nothing was emitted — not 0. */
  readonly rate: number | null;
  /** Wilson 95% interval on the rate. Null when nothing was emitted. */
  readonly interval: { low: number; high: number } | null;
  /** Edits labelled `violated` that produced no `violated` finding. */
  readonly misses: number;
  readonly missRate: number | null;
  readonly perSlice: Record<EditSlice, SliceScore>;
};

/**
 * Wilson score interval at 95% for a proportion of `successes` in `n` trials.
 *
 * Wilson rather than the normal approximation because the whole reason the
 * interval exists is low counts near zero, which is exactly where the normal
 * approximation collapses to a width of nothing.
 */
export function wilsonInterval(
  successes: number,
  n: number,
): { low: number; high: number } {
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

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Throws on broken input rather than skipping it: a finding on an edit the
 * corpus does not hold, or two findings on one edit, would silently move both
 * the numerator and the denominator, which is the hardest kind of wrong number
 * to notice. The caller guarantees every corpus edit has a label.
 */
export function scoreReconciliation(
  edits: readonly EditExpectation[],
  findings: readonly RecordedFinding[],
): ReconciliationScore {
  const byId = new Map(edits.map((edit) => [edit.id, edit]));
  const seen = new Set<string>();

  const perSlice = Object.fromEntries(
    EDIT_SLICES.map((slice) => [
      slice,
      { edits: 0, emitted: 0, falsePositives: 0, misses: 0 },
    ]),
  ) as Record<
    EditSlice,
    { edits: number; emitted: number; falsePositives: number; misses: number }
  >;

  for (const edit of edits) {
    perSlice[edit.slice].edits += 1;
  }

  let emitted = 0;
  let falsePositives = 0;
  const violatedFindingOn = new Set<string>();

  for (const finding of findings) {
    const edit = byId.get(finding.edit);
    if (!edit) {
      throw new Error(
        `finding on '${finding.edit}', which is not an edit in the corpus`,
      );
    }
    if (seen.has(finding.edit)) {
      throw new Error(
        `two findings on edit '${finding.edit}' — one check per edit, one finding per check`,
      );
    }
    seen.add(finding.edit);

    if (finding.verdict !== "violated") {
      continue;
    }
    emitted += 1;
    violatedFindingOn.add(edit.id);
    perSlice[edit.slice].emitted += 1;
    if (edit.expected === "no-finding") {
      falsePositives += 1;
      perSlice[edit.slice].falsePositives += 1;
    }
  }

  let misses = 0;
  let expectedViolated = 0;
  for (const edit of edits) {
    if (edit.expected !== "violated") continue;
    expectedViolated += 1;
    if (!violatedFindingOn.has(edit.id)) {
      misses += 1;
      perSlice[edit.slice].misses += 1;
    }
  }

  return {
    edits: edits.length,
    findings: findings.length,
    emitted,
    falsePositives,
    rate: ratio(falsePositives, emitted),
    interval: emitted === 0 ? null : wilsonInterval(falsePositives, emitted),
    misses,
    missRate: ratio(misses, expectedViolated),
    perSlice,
  };
}

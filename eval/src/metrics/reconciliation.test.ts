import { describe, expect, it } from "vitest";
import {
  type EditExpectation,
  type RecordedFinding,
  scoreReconciliation,
  wilsonInterval,
} from "./reconciliation.js";

/**
 * Machine test fixtures. These are fabricated inputs to a pure function — not
 * an edit corpus and not labels, which only humans construct and write.
 */

const edit = (
  id: string,
  slice: EditExpectation["slice"],
  expected: EditExpectation["expected"],
): EditExpectation => ({ id, slice, expected });

const finding = (
  id: string,
  verdict: RecordedFinding["verdict"],
): RecordedFinding => ({ edit: id, verdict });

describe("wilsonInterval", () => {
  it("brackets the point estimate", () => {
    const interval = wilsonInterval(1, 20);
    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.low).toBeLessThan(0.05);
    expect(interval.high).toBeGreaterThan(0.05);
    expect(interval.high).toBeLessThan(1);
  });

  it("does not collapse to zero width at zero successes", () => {
    // The whole reason Wilson is used: at low counts near zero the normal
    // approximation reports certainty nobody has.
    const interval = wilsonInterval(0, 8);
    expect(interval.low).toBe(0);
    expect(interval.high).toBeGreaterThan(0.2);
  });

  it("refuses zero trials", () => {
    expect(() => wilsonInterval(0, 0)).toThrow(/zero trials/);
  });
});

describe("scoreReconciliation", () => {
  const edits = [
    edit("e1", "seeded-violation", "violated"),
    edit("e2", "seeded-near-miss", "no-finding"),
    edit("e3", "innocent", "no-finding"),
    edit("e4", "legitimate-drift", "violated"),
  ];

  it("counts a violated finding on a no-finding edit as a false positive", () => {
    const score = scoreReconciliation(edits, [
      finding("e1", "violated"),
      finding("e2", "violated"),
      finding("e3", "honored"),
      finding("e4", "violated"),
    ]);

    // Denominator is findings emitted with verdict `violated`, not edits.
    expect(score.emitted).toBe(3);
    expect(score.falsePositives).toBe(1);
    expect(score.rate).toBeCloseTo(1 / 3);
    expect(score.interval?.low).toBeGreaterThan(0);
  });

  it("does not count not_applicable — a retrieval miss is not a false positive", () => {
    const score = scoreReconciliation(edits, [
      finding("e2", "not_applicable"),
      finding("e1", "violated"),
    ]);

    expect(score.emitted).toBe(1);
    expect(score.falsePositives).toBe(0);
    expect(score.rate).toBe(0);
  });

  it("reports the rate as null, never 0, when nothing was emitted", () => {
    const score = scoreReconciliation(edits, [finding("e1", "honored")]);

    expect(score.emitted).toBe(0);
    expect(score.rate).toBeNull();
    expect(score.interval).toBeNull();
    // The degenerate optimum of a kill metric is silence — the misses say so.
    expect(score.misses).toBe(2);
    expect(score.missRate).toBe(1);
  });

  it("publishes the false-negative rate beside the headline", () => {
    const score = scoreReconciliation(edits, [
      finding("e1", "violated"),
      finding("e4", "honored"),
    ]);

    expect(score.misses).toBe(1);
    expect(score.missRate).toBeCloseTo(1 / 2);
  });

  it("keeps legitimate drift apart in the slice report", () => {
    const score = scoreReconciliation(edits, [finding("e4", "violated")]);

    expect(score.perSlice["legitimate-drift"].emitted).toBe(1);
    expect(score.perSlice["legitimate-drift"].falsePositives).toBe(0);
    expect(score.perSlice["seeded-near-miss"].edits).toBe(1);
  });

  it("throws on a finding for an edit the corpus does not hold", () => {
    expect(() =>
      scoreReconciliation(edits, [finding("ghost", "violated")]),
    ).toThrow(/not an edit in the corpus/);
  });

  it("throws on two findings for one edit", () => {
    expect(() =>
      scoreReconciliation(edits, [
        finding("e1", "violated"),
        finding("e1", "honored"),
      ]),
    ).toThrow(/two findings/);
  });
});

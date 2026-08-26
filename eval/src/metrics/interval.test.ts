import { describe, expect, it } from "vitest";
import { formatProportion, proportion, wilsonInterval } from "./interval.js";

describe("proportion", () => {
  it("reports the rate and an interval around it", () => {
    // Hand-computed Wilson at 95% for 8/10, z = 1.959964:
    //   p = 0.8, z² = 3.841457
    //   denominator = 1 + 3.841457/10                = 1.3841457
    //   centre      = 0.8 + 3.841457/20             = 0.99207285
    //   margin      = z·√(0.8·0.2/10 + z²/400)
    //               = 1.959964·√(0.016 + 0.0096036) = 1.959964·0.16001…
    //   low  = (0.99207285 − 0.31362…)/1.3841457    ≈ 0.4901
    //   high = (0.99207285 + 0.31362…)/1.3841457    ≈ 0.9433
    const scored = proportion(8, 10);

    expect(scored.rate).toBe(0.8);
    expect(scored.interval?.low).toBeCloseTo(0.4901, 3);
    expect(scored.interval?.high).toBeCloseTo(0.9433, 3);
  });

  it("narrows as the same rate is measured over more trials", () => {
    // The whole point of reporting it: 0.8 is one number and two different
    // pieces of evidence, and only the width says which one you have.
    const few = proportion(8, 10).interval;
    const many = proportion(800, 1000).interval;
    const width = (i: { low: number; high: number } | null): number =>
      i === null ? Number.NaN : i.high - i.low;

    expect(width(many)).toBeLessThan(width(few));
  });

  it("reports no rate and no interval over zero trials", () => {
    // A proportion of nothing is undefined — not 0, not 1 — and an interval
    // over zero trials is not a thing. Both null, together, so that no caller
    // can print one without the other.
    expect(proportion(0, 0)).toEqual({ rate: null, interval: null });
  });

  it("keeps a certain result inside [0, 1]", () => {
    expect(proportion(5, 5).interval?.high).toBe(1);
    expect(proportion(0, 5).interval?.low).toBe(0);
  });
});

describe("wilsonInterval", () => {
  it("refuses zero trials rather than inventing a width", () => {
    expect(() => wilsonInterval(0, 0)).toThrow(/zero trials/);
  });
});

describe("formatProportion", () => {
  it("prints the rate with the interval beside it", () => {
    expect(formatProportion(proportion(8, 10))).toBe(
      "0.800 (95% CI 0.490–0.943)",
    );
  });

  it("prints n/a when the denominator was zero", () => {
    expect(formatProportion(proportion(0, 0))).toBe("n/a");
  });
});

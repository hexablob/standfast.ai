import { describe, expect, it } from "vitest";
import { distribution, percentile, trimWarmup } from "./latency.js";

/**
 * Percentiles are hand-computed against the nearest-rank definition the module
 * documents: index = ceil(p/100 * n), 1-based, on the ascending sort. Every
 * expectation below is worked out in its comment, because a percentile test
 * that trusts the implementation to say what the answer is tests nothing.
 */

describe("nearest-rank percentiles", () => {
  it("indexes 1..100 the way the definition says", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    // ceil(0.50*100) = 50 → the 50th value = 50.
    expect(percentile(sorted, 50)).toBe(50);
    // ceil(0.95*100) = 95 → the 95th value = 95.
    expect(percentile(sorted, 95)).toBe(95);
    // ceil(0.99*100) = 99 → the 99th value = 99.
    expect(percentile(sorted, 99)).toBe(99);
  });

  it("rounds the rank up, never down", () => {
    const sorted = [10, 20, 30];
    // ceil(0.50*3) = 2 → 20. Linear interpolation would also say 20 here…
    expect(percentile(sorted, 50)).toBe(20);
    // …but ceil(0.90*3) = 3 → 30, where interpolation would say 28.
    expect(percentile(sorted, 90)).toBe(30);
  });

  it("collapses onto the single sample when n = 1", () => {
    // ceil(p/100 * 1) = 1 for every p in (0, 100].
    for (const p of [50, 90, 95, 99]) {
      expect(percentile([7], p)).toBe(7);
    }
  });

  it("splits a pair at p50 and pins the rest to the upper one when n = 2", () => {
    const sorted = [4, 9];
    // ceil(0.50*2) = 1 → the lower of the pair.
    expect(percentile(sorted, 50)).toBe(4);
    // ceil(0.90*2) = ceil(1.8) = 2, and likewise for 95 and 99 → the upper.
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 95)).toBe(9);
    expect(percentile(sorted, 99)).toBe(9);
  });

  it("clamps a rank of zero up to the first sample", () => {
    // ceil(0/100 * 5) = 0, which is not a 1-based index.
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
  });

  it("refuses an empty sample rather than inventing a value", () => {
    expect(() => percentile([], 95)).toThrow(/empty sample/);
  });
});

describe("the distribution", () => {
  it("sorts before it summarises", () => {
    const summary = distribution([30, 10, 50, 20, 40]);
    // Ascending: 10 20 30 40 50. ceil(0.5*5)=3 → 30; ceil(0.9*5)=5 → 50.
    expect(summary).toEqual({
      n: 5,
      min: 10,
      p50: 30,
      p90: 50,
      p95: 50,
      p99: 50,
      max: 50,
    });
  });

  it("reports no mean", () => {
    const summary = distribution([1, 2, 3]);
    expect(Object.keys(summary ?? {})).not.toContain("mean");
  });

  it("is null for an empty sample, not a summary of nothing", () => {
    expect(distribution([])).toBeNull();
  });
});

describe("warm-up trimming", () => {
  it("drops exactly the leading samples", () => {
    expect(trimWarmup([1, 2, 3, 4, 5], 2)).toEqual([3, 4, 5]);
  });

  it("is a no-op at zero", () => {
    expect(trimWarmup([1, 2], 0)).toEqual([1, 2]);
  });

  it("refuses to discard the whole sample", () => {
    expect(() => trimWarmup([1, 2, 3], 3)).toThrow(/discard all 3/);
    expect(() => trimWarmup([1, 2, 3], 9)).toThrow(/discard all 3/);
  });

  it("refuses a negative warm-up", () => {
    expect(() => trimWarmup([1, 2, 3], -1)).toThrow(/negative/);
  });
});

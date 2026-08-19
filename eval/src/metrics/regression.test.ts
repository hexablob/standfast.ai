import { describe, expect, it } from "vitest";
import type { BaselineEntry } from "./regression.js";
import { compareToBaseline } from "./regression.js";

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    direction: "higher-is-better",
    bar: null,
    barIsHardThreshold: false,
    baseline: 0.8,
    noiseBand: 0.02,
    run: "runs/example.json",
    note: "",
    ...overrides,
  };
}

const KILL_METRIC = entry({
  direction: "lower-is-better",
  bar: 0.05,
  barIsHardThreshold: true,
  baseline: 0.01,
  noiseBand: 0.005,
});

describe("compareToBaseline", () => {
  it("passes inside the noise band", () => {
    const result = compareToBaseline(0.79, entry());

    expect(result.status).toBe("pass");
    expect(result.fails).toBe(false);
  });

  it("fails a move below the band", () => {
    const result = compareToBaseline(0.7, entry());

    expect(result.status).toBe("regressed");
    expect(result.fails).toBe(true);
  });

  it("fails an improvement too, until the baseline moves in the same diff", () => {
    const result = compareToBaseline(0.95, entry());

    expect(result.status).toBe("improved");
    expect(result.fails).toBe(true);
    expect(result.reason).toMatch(/baselines\.json/);
  });

  it("reads direction, so a lower number can be the regression", () => {
    const rate = entry({ direction: "lower-is-better", baseline: 0.1 });

    expect(compareToBaseline(0.2, rate).status).toBe("regressed");
    expect(compareToBaseline(0.01, rate).status).toBe("improved");
  });

  it("checks a hard threshold against the value, never against the baseline", () => {
    // The whole point of rule 4. This is the end state a pure delta rule walks
    // to: the baseline has already crept to 4.9% across ten individually green
    // diffs, and 5.2% is *within the noise band of it*. A delta rule passes it.
    const crept = entry({
      direction: "lower-is-better",
      bar: 0.05,
      barIsHardThreshold: true,
      baseline: 0.049,
      noiseBand: 0.005,
    });
    const result = compareToBaseline(0.052, crept);

    expect(result.status).toBe("below-bar");
    expect(result.fails).toBe(true);
  });

  it("still calls a walk toward the bar a regression before it reaches it", () => {
    // 4.9% is under the bar, so it is not a breach — but it is nowhere near
    // the 1% baseline either, and that is what catches the walk on step one.
    const result = compareToBaseline(0.049, KILL_METRIC);

    expect(result.status).toBe("regressed");
    expect(result.fails).toBe(true);
  });

  it("breaches the hard threshold at the bar, not past it", () => {
    // docs/12-evaluation.md says below 5%. 5% is not below 5%.
    expect(compareToBaseline(0.05, KILL_METRIC).status).toBe("below-bar");
    expect(compareToBaseline(0.0499, KILL_METRIC).status).not.toBe("below-bar");
  });

  it("applies the hard threshold even with no baseline to compare against", () => {
    const fresh = entry({
      direction: "lower-is-better",
      bar: 0.05,
      barIsHardThreshold: true,
      baseline: null,
      noiseBand: null,
    });

    expect(compareToBaseline(0.2, fresh).status).toBe("below-bar");
    expect(compareToBaseline(0.01, fresh).status).toBe("ungated");
  });

  it("is ungated, never a pass, with no committed baseline", () => {
    const result = compareToBaseline(0.9, entry({ baseline: null }));

    expect(result.status).toBe("ungated");
    expect(result.status).not.toBe("pass");
  });

  it("is ungated with a baseline but no noise band", () => {
    const result = compareToBaseline(0.9, entry({ noiseBand: null }));

    expect(result.status).toBe("ungated");
  });

  it("ignores a bar that is not marked as a hard threshold", () => {
    const soft = entry({ bar: 0.9, barIsHardThreshold: false });

    expect(compareToBaseline(0.8, soft).status).toBe("pass");
  });
});

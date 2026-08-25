import { describe, expect, it } from "vitest";
import { type PackRecord, scoreRetrieval } from "./retrieval.js";

/**
 * Machine test fixtures. These are fabricated inputs to a pure function — not
 * corpus labels, which only a human writes.
 */

const record = (over: Partial<PackRecord>): PackRecord => ({
  queryId: "q1",
  paraphrased: false,
  budgetTokens: 500,
  budgetTokensUsed: 400,
  delivered: [],
  governing: [],
  ...over,
});

describe("scoreRetrieval", () => {
  it("computes pooled precision per budget", () => {
    const score = scoreRetrieval([
      record({ delivered: ["a", "b"], governing: ["a"] }),
      record({ queryId: "q2", delivered: ["c", "d"], governing: ["c", "d"] }),
    ]);

    expect(score.budgets).toHaveLength(1);
    expect(score.budgets[0]?.precision).toBeCloseTo(3 / 4);
    expect(score.budgets[0]?.queries).toBe(2);
  });

  it("reports precision null, not 1 and not 0, when nothing was delivered", () => {
    const score = scoreRetrieval([record({ governing: ["a"] })]);

    expect(score.budgets[0]?.precision).toBeNull();
    // The governing atom existed and was not delivered — that is displacement.
    expect(score.budgets[0]?.displacement).toBe(1);
  });

  it("counts displacement as governing atoms that existed and did not fit", () => {
    const score = scoreRetrieval([
      record({ delivered: ["a"], governing: ["a", "b", "c"] }),
    ]);

    expect(score.budgets[0]?.displacement).toBe(2);
  });

  it("returns a curve, ascending by budget", () => {
    const score = scoreRetrieval([
      record({ budgetTokens: 2000, delivered: ["a"], governing: ["a"] }),
      record({ budgetTokens: 500, delivered: ["a", "x"], governing: ["a"] }),
      record({ budgetTokens: 1000, delivered: ["a"], governing: ["a"] }),
    ]);

    expect(score.budgets.map((row) => row.budgetTokens)).toEqual([
      500, 1000, 2000,
    ]);
    expect(score.budgets[0]?.precision).toBeCloseTo(1 / 2);
  });

  it("reports the paraphrased slice on its own", () => {
    const score = scoreRetrieval([
      record({ delivered: ["a"], governing: ["a"] }),
      record({
        queryId: "q2",
        paraphrased: true,
        delivered: ["b", "x"],
        governing: ["b"],
      }),
    ]);

    expect(score.budgets[0]?.precision).toBeCloseTo(2 / 3);
    expect(score.paraphrased).toHaveLength(1);
    expect(score.paraphrased[0]?.precision).toBeCloseTo(1 / 2);
    expect(score.paraphrased[0]?.queries).toBe(1);
  });

  it("tracks the largest reported budget use", () => {
    const score = scoreRetrieval([
      record({ budgetTokensUsed: 120 }),
      record({ queryId: "q2", budgetTokensUsed: 480 }),
    ]);

    expect(score.budgets[0]?.budgetTokensUsedMax).toBe(480);
  });
});

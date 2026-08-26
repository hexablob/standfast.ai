import { describe, expect, it } from "vitest";
import type { AdjudicatedAtom } from "./extraction.js";
import { scoreExtraction } from "./extraction.js";

const SECTION = "a".repeat(64);

function accepted(
  matched: string | null,
  miscategorised = false,
): AdjudicatedAtom {
  return {
    sectionHash: SECTION,
    statement: "Postgres 16 with pgvector.",
    kind: "decision",
    quote: "Postgres 16 with pgvector",
    verdict: { accepted: true, matched, miscategorised },
  };
}

function rejected(
  rejection: "unsupported" | "not-knowledge" | "duplicate",
): AdjudicatedAtom {
  return {
    sectionHash: SECTION,
    statement: "The team likes Postgres.",
    kind: "decision",
    quote: "Postgres 16 with pgvector",
    verdict: { accepted: false, rejection },
  };
}

describe("scoreExtraction", () => {
  it("divides by atoms emitted, not by sections and not by ratifications", () => {
    const score = scoreExtraction(
      [accepted("x#0"), accepted(null), rejected("duplicate")],
      ["x#0", "x#1"],
    );

    expect(score.emitted).toBe(3);
    expect(score.accepted).toBe(2);
    expect(score.precision.rate).toBeCloseTo(2 / 3);
  });

  it("does not subtract a miscategorised atom from precision", () => {
    const score = scoreExtraction([accepted("x#0", true)], ["x#0"]);

    expect(score.precision.rate).toBe(1);
    expect(score.miscategorised).toMatchObject({ count: 1, rate: 1 });
  });

  it("reports precision as null when nothing was emitted", () => {
    // Not 1 — an extractor that emits nothing is not perfectly precise. Not 0
    // either. There is no measurement, and the run has to say so.
    const score = scoreExtraction([], ["x#0"]);

    expect(score.precision.rate).toBeNull();
    expect(score.precision.interval).toBeNull();
    expect(score.recall).toMatchObject({ expected: 1, matched: 0, rate: 0 });
  });

  it("counts the three rejection reasons separately", () => {
    const score = scoreExtraction(
      [
        rejected("unsupported"),
        rejected("not-knowledge"),
        rejected("not-knowledge"),
        rejected("duplicate"),
      ],
      [],
    );

    expect(score.rejections).toEqual({
      unsupported: 1,
      "not-knowledge": 2,
      duplicate: 1,
    });
  });

  it("fails the gate on any unsupported atom, whatever the precision", () => {
    const many = Array.from({ length: 99 }, () => accepted(null));
    const score = scoreExtraction([...many, rejected("unsupported")], []);

    expect(score.precision.rate).toBeCloseTo(0.99);
    expect(score.gate).toEqual({ unsupported: 1, passed: false });
  });

  it("passes the gate when every rejection is a prompt or dedup problem", () => {
    const score = scoreExtraction(
      [rejected("not-knowledge"), rejected("duplicate")],
      [],
    );

    expect(score.gate).toEqual({ unsupported: 0, passed: true });
  });

  it("counts each expected atom once however many atoms matched it", () => {
    const score = scoreExtraction(
      [accepted("x#0"), accepted("x#0"), accepted("x#1")],
      ["x#0", "x#1", "x#2"],
    );

    expect(score.recall).toMatchObject({
      expected: 3,
      matched: 2,
      rate: 2 / 3,
    });
  });

  it("keeps an unmatched acceptance out of recall but inside precision", () => {
    // The extractor found something the labeller did not write. It is a true
    // atom, so it counts in precision; recall is measured against what was
    // written blind, so it cannot count there.
    const score = scoreExtraction([accepted(null)], ["x#0"]);

    expect(score.precision.rate).toBe(1);
    expect(score.recall.matched).toBe(0);
  });

  it("throws when an adjudication matches an expected atom that does not exist", () => {
    expect(() => scoreExtraction([accepted("x#9")], ["x#0"])).toThrow(
      /not an expected atom/,
    );
  });

  it("reports recall as null when no section had anything expected", () => {
    const score = scoreExtraction([accepted(null)], []);

    expect(score.recall.rate).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { bandFor, cosineSimilarity, DEDUP_BANDS } from "./similarity.js";

describe("cosineSimilarity", () => {
  it("is 1 for a vector against itself", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  it("ignores magnitude", () => {
    expect(cosineSimilarity([1, 0], [7, 0])).toBeCloseTo(1, 12);
  });

  it("is 0 for orthogonal vectors and -1 for opposed ones", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
  });

  it("is 0 against a zero vector rather than NaN", () => {
    // A zero vector has no direction. NaN here would compare false against
    // every band boundary and land the candidate in "distinct" by accident
    // rather than on purpose.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("refuses vectors of different lengths", () => {
    // A provider returning 1536 where the column is 1024 must fail here, loudly,
    // rather than produce a number from whatever the shorter one had.
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/equal lengths/);
  });
});

describe("bandFor", () => {
  it("puts each boundary in the higher band", () => {
    // Stated once so no call site has to decide whether 0.80 exactly means ask
    // or ignore.
    expect(bandFor(DEDUP_BANDS.judgeFrom)).toBe("judge");
    expect(bandFor(DEDUP_BANDS.duplicateFrom)).toBe("duplicate");
  });

  it("puts a hair below each boundary in the lower band", () => {
    expect(bandFor(0.7999999)).toBe("distinct");
    expect(bandFor(0.9299999)).toBe("judge");
  });

  it("covers the extremes", () => {
    expect(bandFor(-1)).toBe("distinct");
    expect(bandFor(0)).toBe("distinct");
    expect(bandFor(1)).toBe("duplicate");
  });

  it("holds the settled thresholds", () => {
    // These move only against a corpus of atom pairs a human labelled, which
    // does not exist yet. A diff that changes either number without one is the
    // failure docs/02-principles.md (10) names.
    expect(DEDUP_BANDS).toEqual({ judgeFrom: 0.8, duplicateFrom: 0.93 });
  });
});

import { describe, expect, it } from "vitest";
import { RRF_K, rrfFuse } from "./rrf.js";

describe("rrfFuse", () => {
  it("sums the reciprocal ranks the design document states", () => {
    const fused = rrfFuse({ dense: ["a", "b"], lexical: ["b"] });

    const a = fused.find((f) => f.atomId === "a");
    const b = fused.find((f) => f.atomId === "b");

    expect(a?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(b?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
  });

  /**
   * The whole point of fusion: an atom two generators agree on outranks one
   * that a single generator put first. At k = 60 the top-of-list gap is small
   * enough that agreement wins, which is what damping buys.
   */
  it("puts an atom two generators found above one only the first did", () => {
    const fused = rrfFuse({ dense: ["a", "b"], lexical: ["b", "c"] });

    expect(fused[0]?.atomId).toBe("b");
  });

  it("records which generators returned each atom", () => {
    const fused = rrfFuse({ dense: ["a"], lexical: ["a"], trigram: ["b"] });

    expect(fused.find((f) => f.atomId === "a")?.generators).toEqual([
      "dense",
      "lexical",
    ]);
    expect(fused.find((f) => f.atomId === "b")?.generators).toEqual([
      "trigram",
    ]);
  });

  /**
   * A generator returning the same atom twice is a bug. Summing both ranks
   * would let that bug buy rank, so the best one is kept and the rest ignored.
   */
  it("keeps only an atom's best rank within one generator's list", () => {
    const fused = rrfFuse({ dense: ["a", "a", "a"] });

    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused[0]?.generators).toEqual(["dense"]);
  });

  /**
   * The evaluation harness compares rankings across runs. An unstable
   * tie-break shows up there as noise and gets attributed to the retriever, so
   * the order has to be total rather than merely sorted.
   */
  it("breaks ties on atom id, so the order is total", () => {
    const forward = rrfFuse({ dense: ["b"], lexical: ["a"] });
    const backward = rrfFuse({ lexical: ["a"], dense: ["b"] });

    expect(forward.map((f) => f.atomId)).toEqual(["a", "b"]);
    expect(backward.map((f) => f.atomId)).toEqual(["a", "b"]);
  });

  it("fuses nothing into nothing", () => {
    expect(rrfFuse({})).toEqual([]);
    expect(rrfFuse({ dense: [] })).toEqual([]);
  });

  /**
   * Availability, not just quality: when the query embedding is slow or down,
   * generator 1 drops out and the other three still answer. The fused order
   * degrades; the request does not fail.
   */
  it("degrades to the surviving generators when one drops out", () => {
    const withDense = rrfFuse({ dense: ["a"], lexical: ["b"], trigram: ["b"] });
    const withoutDense = rrfFuse({ lexical: ["b"], trigram: ["b"] });

    expect(withDense[0]?.atomId).toBe("b");
    expect(withoutDense.map((f) => f.atomId)).toEqual(["b"]);
  });
});

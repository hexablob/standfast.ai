import { describe, expect, it } from "vitest";
import { MMR_LAMBDA, type MmrCandidate, mmrSelect } from "./mmr.js";

const takeAll = () => true;
const take = (n: number) => (_c: MmrCandidate, selected: readonly unknown[]) =>
  selected.length < n;

/** Unit vectors, so cosine is readable straight off the page. */
const EAST = [1, 0];
const NORTH = [0, 1];
/** Cosine 0.9 to EAST. */
const NEAR_EAST = [0.9, Math.sqrt(1 - 0.81)];

describe("mmrSelect", () => {
  it("takes the most relevant first, when nothing is selected yet", () => {
    const { selected } = mmrSelect(
      [
        { atomId: "low", relevance: 0.1, embedding: EAST },
        { atomId: "high", relevance: 0.9, embedding: NORTH },
      ],
      take(1),
    );

    expect(selected.map((c) => c.atomId)).toEqual(["high"]);
  });

  /**
   * The failure MMR is here to prevent: a budget spent on five phrasings of one
   * convention, reported as a full pack.
   */
  it("prefers a distinct atom over a near-duplicate of similar relevance", () => {
    const { selected } = mmrSelect(
      [
        { atomId: "first", relevance: 1.0, embedding: EAST },
        { atomId: "duplicate", relevance: 0.5, embedding: EAST },
        { atomId: "distinct", relevance: 0.49, embedding: NORTH },
      ],
      take(2),
    );

    expect(selected.map((c) => c.atomId)).toEqual(["first", "distinct"]);
  });

  /**
   * λ = 0.7 keeps relevance dominant. Diversity is a correction, not the
   * objective — an atom that is clearly more relevant still wins despite
   * sitting close to what is already selected.
   */
  it("still lets a clearly more relevant atom win at λ = 0.7", () => {
    expect(MMR_LAMBDA).toBe(0.7);

    const { selected } = mmrSelect(
      [
        { atomId: "first", relevance: 1.0, embedding: EAST },
        { atomId: "close-but-relevant", relevance: 0.98, embedding: NEAR_EAST },
        { atomId: "far-but-weak", relevance: 0.0, embedding: NORTH },
      ],
      take(2),
    );

    expect(selected.map((c) => c.atomId)).toEqual([
      "first",
      "close-but-relevant",
    ]);
  });

  /**
   * The regression this module's `normaliseRelevance` exists for.
   *
   * Fed raw RRF scores — which top out near `4 / 61` — against cosine
   * similarity, which runs to 1, the diversity term outweighs everything and λ
   * stops meaning anything. These are exactly the numbers the fused query
   * produces, and the expected answer is the same as the test above: relevance
   * dominates. If normalisation is removed, `far-but-weak` is selected instead.
   */
  it("is not swamped when relevance arrives on the RRF scale", () => {
    const { selected } = mmrSelect(
      [
        { atomId: "first", relevance: 4 / 61, embedding: EAST },
        {
          atomId: "close-but-relevant",
          relevance: 3 / 61,
          embedding: NEAR_EAST,
        },
        { atomId: "far-but-weak", relevance: 1 / 61, embedding: NORTH },
      ],
      take(2),
    );

    expect(selected.map((c) => c.atomId)).toEqual([
      "first",
      "close-but-relevant",
    ]);
  });

  it("reduces to diversity alone when every candidate is equally relevant", () => {
    const { selected } = mmrSelect(
      [
        { atomId: "a", relevance: 0.5, embedding: EAST },
        { atomId: "b", relevance: 0.5, embedding: EAST },
        { atomId: "c", relevance: 0.5, embedding: NORTH },
      ],
      take(2),
    );

    expect(selected.map((c) => c.atomId)).toEqual(["a", "c"]);
  });

  /**
   * An atom extraction has not embedded yet is not a known duplicate. It takes
   * no diversity penalty, which biases the pack towards including it — the safe
   * direction, since excluding it would hide knowledge for a reason no agent
   * could see.
   */
  it("charges no diversity penalty to an atom with no embedding", () => {
    const { selected } = mmrSelect(
      [
        { atomId: "first", relevance: 1.0, embedding: EAST },
        { atomId: "unembedded", relevance: 0.2, embedding: null },
        { atomId: "duplicate", relevance: 0.2, embedding: EAST },
      ],
      take(2),
    );

    expect(selected.map((c) => c.atomId)).toEqual(["first", "unembedded"]);
  });

  it("reports what it left behind, rather than leaving it to be inferred", () => {
    const { selected, dropped } = mmrSelect(
      [
        { atomId: "a", relevance: 0.9, embedding: EAST },
        { atomId: "b", relevance: 0.8, embedding: NORTH },
        { atomId: "c", relevance: 0.7, embedding: EAST },
      ],
      take(1),
    );

    expect(selected).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("drops nothing when everything fits", () => {
    const { selected, dropped } = mmrSelect(
      [
        { atomId: "a", relevance: 0.9, embedding: EAST },
        { atomId: "b", relevance: 0.8, embedding: NORTH },
      ],
      takeAll,
    );

    expect(selected).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("selects nothing, and drops everything, when nothing fits", () => {
    const { selected, dropped } = mmrSelect(
      [{ atomId: "a", relevance: 0.9, embedding: EAST }],
      () => false,
    );

    expect(selected).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("hands back the candidates it was given, not the rescaled ones", () => {
    const candidate: MmrCandidate = {
      atomId: "a",
      relevance: 4 / 61,
      embedding: EAST,
    };

    const { selected } = mmrSelect([candidate], takeAll);

    expect(selected[0]).toBe(candidate);
  });
});

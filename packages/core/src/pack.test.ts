import { describe, expect, it } from "vitest";
import {
  assemblePack,
  EMPTY_PACK_TOKENS,
  PACK_ORDER,
  type PackCandidate,
} from "./pack.js";

const EAST = [1, 0];
const NORTH = [0, 1];

function candidate(
  atomId: string,
  kind: PackCandidate["kind"],
  relevance: number,
  embedding: readonly number[] | null = EAST,
): PackCandidate {
  return {
    atomId,
    kind,
    relevance,
    embedding,
    statement: `A ${kind} that says something about ${atomId} at some length.`,
    provenance: `docs/0${atomId.length}-example.md#Section for ${atomId}`,
  };
}

const CANDIDATES: PackCandidate[] = [
  candidate("alpha", "decision", 0.9, EAST),
  candidate("bravo", "constraint", 0.8, NORTH),
  candidate("charlie", "convention", 0.7, [0.5, 0.866]),
  candidate("delta", "decision", 0.6, [0.866, 0.5]),
  candidate("echo", "constraint", 0.5, [-1, 0]),
];

const GENEROUS = 100_000;

describe("assemblePack", () => {
  /**
   * `docs/14-roadmap.md` phase 2 exit criterion 1: the assembled pack is at or
   * under `budgetTokens`. A gate, not a measurement — so this sweeps a range
   * rather than checking one convenient number.
   */
  it("never exceeds any budget an empty envelope could fit in", () => {
    for (let budget = EMPTY_PACK_TOKENS; budget <= 400; budget += 7) {
      const pack = assemblePack({
        candidates: CANDIDATES,
        budgetTokens: budget,
        upstreamTruncated: false,
        skipped: [],
      });

      expect(pack.budgetTokensUsed).toBeLessThanOrEqual(budget);
    }
  });

  /**
   * The floor, named rather than discovered in production.
   *
   * Below it no response fits — not even the empty one — so the assembler
   * reports what it actually sent instead of a zero that would be a lie.
   */
  it("reports the envelope floor honestly when the budget is below it", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: 0,
      upstreamTruncated: false,
      skipped: [],
    });

    expect(pack.items).toEqual([]);
    expect(pack.budgetTokensUsed).toBe(EMPTY_PACK_TOKENS);
    expect(pack.truncated).toBe(true);
  });

  /**
   * Attention is positional, and the cost of an agent missing a constraint is
   * higher than the cost of it missing a decision. So the order is the
   * contract's, whatever the scores were.
   */
  it("orders constraint, then convention, then decision", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: GENEROUS,
      upstreamTruncated: false,
      skipped: [],
    });

    const ranks = pack.items.map((item) => PACK_ORDER.indexOf(item.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(pack.items[0]?.kind).toBe("constraint");
  });

  it("carries provenance and never the source quote", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: GENEROUS,
      upstreamTruncated: false,
      skipped: [],
    });

    for (const item of pack.items) {
      expect(Object.keys(item).sort()).toEqual([
        "atomId",
        "kind",
        "provenance",
        "statement",
      ]);
      expect(item.provenance).toContain("#");
    }
  });

  /**
   * The flag must stay informative. A generous budget over a handful of atoms
   * drops nothing, and `truncated` is then false — it is not set defensively,
   * because a flag that is always true is one the agent learns to ignore.
   */
  it("is not truncated when everything fits and nothing was dropped upstream", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: GENEROUS,
      upstreamTruncated: false,
      skipped: [],
    });

    expect(pack.returned).toBe(CANDIDATES.length);
    expect(pack.truncated).toBe(false);
  });

  /**
   * Roadmap phase 2 exit criterion 2, at this layer: `returned == total` and
   * results were still dropped — upstream, by a generator's cap. The flag comes
   * from the stage that dropped them and is never recomputed from the counts,
   * because by here that information is gone.
   */
  it("stays truncated when an upstream stage dropped something, even with a full pack", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: GENEROUS,
      upstreamTruncated: true,
      skipped: [],
    });

    expect(pack.returned).toBe(pack.total);
    expect(pack.truncated).toBe(true);
  });

  it("is truncated when the budget dropped something", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: 90,
      upstreamTruncated: false,
      skipped: [],
    });

    expect(pack.returned).toBeLessThan(pack.total);
    expect(pack.truncated).toBe(true);
  });

  /**
   * An empty pack is a valid response. `docs/01-thesis.md`: the pack informs
   * the work, it never gates it — so a budget too small for one atom returns
   * nothing and lets the agent proceed on its own judgment.
   */
  it("returns an empty pack rather than an error when nothing fits", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: 1,
      upstreamTruncated: false,
      skipped: [],
    });

    expect(pack.items).toEqual([]);
    expect(pack.total).toBe(CANDIDATES.length);
    expect(pack.truncated).toBe(true);
  });

  it("returns an empty, untruncated pack when there were no candidates", () => {
    const pack = assemblePack({
      candidates: [],
      budgetTokens: GENEROUS,
      upstreamTruncated: false,
      skipped: [],
    });

    expect(pack.items).toEqual([]);
    expect(pack.total).toBe(0);
    expect(pack.truncated).toBe(false);
  });

  /**
   * `total` means candidates that survived fusion — not atoms that could have
   * matched, which nobody can compute. Pinned by a test because the meaning is
   * the part an agent gets wrong.
   */
  it("counts total as the candidates it was given, not as what it returned", () => {
    const pack = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: 90,
      upstreamTruncated: false,
      skipped: [],
    });

    expect(pack.total).toBe(CANDIDATES.length);
    expect(pack.returned).toBeLessThan(pack.total);
  });

  /**
   * Skipped stages cost tokens to report, and the budget has to cover them.
   * Counting the pack without them would overshoot the moment the reranker
   * dropped out.
   */
  it("counts the skipped-stage report against the budget", () => {
    const quiet = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: GENEROUS,
      upstreamTruncated: false,
      skipped: [],
    });
    const noisy = assemblePack({
      candidates: CANDIDATES,
      budgetTokens: GENEROUS,
      upstreamTruncated: false,
      skipped: ["reranker", "dense"],
    });

    expect(noisy.budgetTokensUsed).toBeGreaterThan(quiet.budgetTokensUsed);
  });
});

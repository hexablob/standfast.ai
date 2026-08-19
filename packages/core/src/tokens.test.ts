import { describe, expect, it } from "vitest";
import { CHARS_PER_ALPHANUMERIC_TOKEN, tokenUpperBound } from "./tokens.js";

/**
 * The property that matters is the *direction* of the error.
 *
 * A token count that is sometimes low is a budget that is sometimes exceeded,
 * and `docs/14-roadmap.md` phase 2 exit criterion 1 makes the budget a gate. So
 * these tests are about the bound never sagging, not about it being tight.
 */
describe("tokenUpperBound", () => {
  it("costs nothing for nothing", () => {
    expect(tokenUpperBound("")).toBe(0);
  });

  it("charges nothing for whitespace, which rides along with the next token", () => {
    expect(tokenUpperBound("   \n\t  ")).toBe(0);
  });

  it("charges an alphanumeric run at the stated ratio", () => {
    expect(CHARS_PER_ALPHANUMERIC_TOKEN).toBe(3);
    // "convention" is ten characters, so four tokens by this bound. A real
    // tokenizer emits one or two; the gap is the margin, deliberately.
    expect(tokenUpperBound("convention")).toBe(4);
  });

  it("charges punctuation one token each, because it rarely merges", () => {
    expect(tokenUpperBound("{}[],:")).toBe(6);
  });

  /**
   * The reason this module exists rather than a division by four.
   *
   * A serialised envelope is mostly punctuation, and the naive prose
   * approximation under-counts it — which is the one error a budget gate cannot
   * absorb.
   */
  it("counts a serialised envelope above the naive four-characters-per-token", () => {
    const serialised = JSON.stringify({
      items: [
        {
          atomId: "e6f3f2b8-0d5e-4a3b-9c1a-2f6b8d4e7a10",
          statement: "packages/core is pure domain: no I/O.",
          kind: "constraint",
          provenance: "CLAUDE.md#Code conventions",
        },
      ],
      total: 1,
      returned: 1,
      truncated: false,
      budgetTokensUsed: 2000,
      skipped: [],
    });

    expect(tokenUpperBound(serialised)).toBeGreaterThan(serialised.length / 4);
  });

  it("never decreases when text is appended", () => {
    const head = "The assembler respects the budget;";
    const tail = " it does not approximate it.";

    expect(tokenUpperBound(head + tail)).toBeGreaterThanOrEqual(
      tokenUpperBound(head),
    );
  });

  /**
   * Code points, not UTF-16 code units — the same unit `quote.ts` counts in.
   * An emoji is one character and must not be charged as the two units
   * `String.prototype.length` reports.
   */
  it("counts astral characters once", () => {
    expect(tokenUpperBound("🙂")).toBe(1);
  });
});

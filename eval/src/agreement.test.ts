import { describe, expect, it } from "vitest";
import { agreementBetween, agreements } from "./agreement.js";
import { type LabelSet, type SectionLabel, UNREAD } from "./labels.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function section(sectionHash: string, quotes: readonly string[]): SectionLabel {
  return {
    ordinal: 0,
    headingPath: ["Stack"],
    sectionHash,
    expect: quotes.map((quote) => ({
      statement: quote,
      kind: "decision" as const,
      quote,
    })),
  };
}

function labels(
  labeller: string,
  sections: SectionLabel[],
  document = "self/03-architecture.md",
): LabelSet {
  return {
    version: 1,
    document,
    documentHash: "d".repeat(64),
    labeller,
    labelledOn: "2026-08-07",
    blind: true,
    modelAssisted: false,
    sections,
  };
}

/** A section listed but not read — what a fresh skeleton is made of. */
function unread(sectionHash: string): SectionLabel {
  return { ordinal: 0, headingPath: ["Stack"], sectionHash, expect: UNREAD };
}

describe("agreementBetween", () => {
  it("finds no agreement between two untouched skeletons", () => {
    // The trap: identical empty entries agreed with each other, so two people
    // who had each done nothing reported perfect agreement over every section
    // — corrupting the second of the two signals that say whether the corpus
    // is ready to produce a figure.
    const left = labels("ana", [unread(HASH_A), unread(HASH_B)]);
    const right = labels("bo", [unread(HASH_A), unread(HASH_B)]);

    expect(agreementBetween(left, right)).toBeNull();
  });

  it("counts a section only once both labellers have read it", () => {
    const left = labels("ana", [section(HASH_A, []), unread(HASH_B)]);
    const right = labels("bo", [section(HASH_A, []), section(HASH_B, ["x"])]);

    const agreement = agreementBetween(left, right);

    expect(agreement?.overlap).toBe(1);
    expect(agreement?.unread).toBe(1);
    expect(agreement?.emptiness).toEqual({ agreed: 1, of: 1 });
  });

  it("separates 'we both say nothing' from 'neither of us has looked'", () => {
    // Both are `expect` with no atoms in it, and only one of them is a claim.
    const bothEmpty = agreementBetween(
      labels("ana", [section(HASH_A, [])]),
      labels("bo", [section(HASH_A, [])]),
    );
    const bothUnread = agreementBetween(
      labels("ana", [unread(HASH_A)]),
      labels("bo", [unread(HASH_A)]),
    );

    expect(bothEmpty?.emptiness).toEqual({ agreed: 1, of: 1 });
    expect(bothUnread).toBeNull();
  });

  it("only counts sections both labellers wrote an entry for", () => {
    const left = labels("ana", [section(HASH_A, ["x"]), section(HASH_B, [])]);
    const right = labels("bo", [section(HASH_A, ["x"]), section(HASH_C, [])]);

    expect(agreementBetween(left, right)?.overlap).toBe(1);
  });

  it("separates agreeing on emptiness from agreeing on count", () => {
    const left = labels("ana", [
      section(HASH_A, ["x", "y"]),
      section(HASH_B, []),
    ]);
    const right = labels("bo", [section(HASH_A, ["x"]), section(HASH_B, [])]);

    const result = agreementBetween(left, right);

    expect(result?.emptiness).toEqual({ agreed: 2, of: 2 });
    expect(result?.count).toEqual({ agreed: 1, of: 2 });
  });

  it("scores exact quotes, which is a lower bound and meant to be", () => {
    // Two labellers quoting different halves of the same sentence agree in
    // substance and score zero here. Claim-level agreement needs a human, and
    // never a model of the extractor's family.
    const left = labels("ana", [section(HASH_A, ["Postgres 16"])]);
    const right = labels("bo", [
      section(HASH_A, ["Postgres 16 with pgvector"]),
    ]);

    expect(agreementBetween(left, right)?.quoteJaccard).toBe(0);
  });

  it("reports no quote score when both labellers found nothing to quote", () => {
    const left = labels("ana", [section(HASH_A, [])]);
    const right = labels("bo", [section(HASH_A, [])]);

    const result = agreementBetween(left, right);

    expect(result?.quoteJaccard).toBeNull();
    expect(result?.emptiness).toEqual({ agreed: 1, of: 1 });
  });

  it("returns null for label sets of different documents", () => {
    const left = labels("ana", [section(HASH_A, ["x"])], "self/a.md");
    const right = labels("bo", [section(HASH_A, ["x"])], "self/b.md");

    expect(agreementBetween(left, right)).toBeNull();
  });

  it("returns null when the two labellers share no section", () => {
    const left = labels("ana", [section(HASH_A, ["x"])]);
    const right = labels("bo", [section(HASH_B, ["x"])]);

    expect(agreementBetween(left, right)).toBeNull();
  });
});

describe("agreements", () => {
  it("pairs every labeller with every other, once", () => {
    const all = [
      labels("ana", [section(HASH_A, ["x"])]),
      labels("bo", [section(HASH_A, ["x"])]),
      labels("cy", [section(HASH_A, ["x"])]),
    ];

    expect(agreements(all).map((a) => a.pair)).toEqual([
      ["ana", "bo"],
      ["ana", "cy"],
      ["bo", "cy"],
    ]);
  });

  it("does not pair a labeller with themselves across two documents", () => {
    const all = [
      labels("ana", [section(HASH_A, ["x"])], "self/a.md"),
      labels("ana", [section(HASH_A, ["x"])], "self/b.md"),
    ];

    expect(agreements(all)).toEqual([]);
  });
});

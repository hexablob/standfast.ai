import { describe, expect, it } from "vitest";
import {
  type ExtractorVersionInputs,
  extractorVersion,
} from "./extractor-version.js";

const BASE: ExtractorVersionInputs = {
  promptVersion: "p1",
  extractionModel: "fake-bullet-1",
  embeddingModel: "fake-bow-1",
  judgeModel: "fake-judge-1",
};

describe("extractorVersion", () => {
  it("is stable across calls", () => {
    expect(extractorVersion(BASE)).toBe(extractorVersion({ ...BASE }));
  });

  it("looks like a version", () => {
    expect(extractorVersion(BASE)).toMatch(/^ev1-[0-9a-f]{16}$/);
  });

  it("changes when any input changes", () => {
    const base = extractorVersion(BASE);
    const variants: ExtractorVersionInputs[] = [
      { ...BASE, promptVersion: "p2" },
      { ...BASE, extractionModel: "real-1" },
      { ...BASE, embeddingModel: "voyage-3" },
      { ...BASE, judgeModel: "other-judge" },
      { ...BASE, judgeFrom: 0.81 },
      { ...BASE, duplicateFrom: 0.94 },
      { ...BASE, sectionerVersion: "2" },
      { ...BASE, orderingVersion: "2" },
    ];

    for (const v of variants) {
      expect(extractorVersion(v)).not.toBe(base);
    }
    expect(new Set(variants.map(extractorVersion)).size).toBe(variants.length);
  });

  it("changes when the embedding model changes, though it proposes no candidates", () => {
    // The embedding model does not decide which candidates the extractor
    // proposes. It decides which of them survive dedup, and re-embedding
    // without re-deduplicating leaves a corpus inconsistent with its own merge
    // threshold and nothing to surface it.
    expect(extractorVersion({ ...BASE, embeddingModel: "voyage-3" })).not.toBe(
      extractorVersion(BASE),
    );
  });

  it("does not collide when a delimiter moves between components", () => {
    // Length-prefixed, not separator-joined, for the same reason sectionHash
    // length-prefixes a heading path.
    const a = extractorVersion({
      ...BASE,
      extractionModel: "a-b",
      promptVersion: "c",
    });
    const b = extractorVersion({
      ...BASE,
      extractionModel: "a",
      promptVersion: "b-c",
    });
    expect(a).not.toBe(b);
  });

  it("does not depend on the order fields were written in", () => {
    const reordered: ExtractorVersionInputs = {
      judgeModel: BASE.judgeModel,
      embeddingModel: BASE.embeddingModel,
      extractionModel: BASE.extractionModel,
      promptVersion: BASE.promptVersion,
    };
    expect(extractorVersion(reordered)).toBe(extractorVersion(BASE));
  });

  it("treats an omitted band as the settled default", () => {
    expect(
      extractorVersion({ ...BASE, judgeFrom: 0.8, duplicateFrom: 0.93 }),
    ).toBe(extractorVersion(BASE));
  });
});

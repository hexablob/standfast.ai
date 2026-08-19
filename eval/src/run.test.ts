import { describe, expect, it } from "vitest";
import { RunFile } from "./run.js";

/**
 * The run file is what makes a number reproducible, so what it refuses matters
 * more than what it accepts.
 */

const BASE = {
  version: 1 as const,
  metric: "extraction_precision" as const,
  ranOn: "2026-08-10",
  corpusRevision: "6c020914f6b6906b",
  codeRevision: "a3255ee",
  models: {
    extraction: { name: "claude-opus-5", version: "p1" },
    embedding: { name: "voyage-3", version: "p1" },
    judge: { name: "claude-sonnet-5", version: "p1" },
  },
  extractorVersion: "ev1-0123456789abcdef",
  configuration: {},
  slice: "all" as const,
  coverage: { self: 17, public: 40, synthetic: 0 },
  split: "held-out" as const,
  labels: {
    labellers: ["a"],
    blind: true,
    modelAssisted: false,
  },
  expectedAtomIds: [],
  adjudications: [],
  score: null,
};

describe("RunFile", () => {
  it("accepts a run that names all three models", () => {
    expect(RunFile.safeParse(BASE).success).toBe(true);
  });

  it("refuses a run that names only one model", () => {
    // Phase 1 has three, and each changes the output differently: the extractor
    // decides what is proposed, the embedder decides what survives dedup, the
    // judge decides the middle band. "The model" would name whichever one
    // somebody thought was interesting.
    const { models, ...rest } = BASE;
    const oneModel = {
      ...rest,
      model: { name: "claude-opus-5", version: "p1" },
    };
    expect(RunFile.safeParse(oneModel).success).toBe(false);
  });

  it("refuses a run with no extractor version", () => {
    // It is what joins the number to the section_extractions rows that produced
    // it. Without it the run is a number with no way back to its evidence.
    const { extractorVersion, ...rest } = BASE;
    expect(RunFile.safeParse(rest).success).toBe(false);
  });

  it("refuses a self-only corpus reported as the headline slice", () => {
    // The guard this schema exists for. docs/12-evaluation.md reports the self
    // tier separately and never folds it into a headline, and the first run is
    // the one that sets a bar the project may then only tighten.
    const selfOnly = {
      ...BASE,
      slice: "all" as const,
      coverage: { self: 17, public: 0, synthetic: 0 },
    };
    const parsed = RunFile.safeParse(selfOnly);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(
      /cannot be reported as/,
    );
  });

  it("accepts a self-only corpus reported honestly", () => {
    const honest = {
      ...BASE,
      slice: "self" as const,
      coverage: { self: 17, public: 0, synthetic: 0 },
    };
    expect(RunFile.safeParse(honest).success).toBe(true);
  });

  it("refuses a single-tier slice that covered another tier too", () => {
    const mixed = {
      ...BASE,
      slice: "public" as const,
      coverage: { self: 17, public: 40, synthetic: 0 },
    };
    expect(RunFile.safeParse(mixed).success).toBe(false);
  });

  it("refuses a run that covered nothing", () => {
    const empty = {
      ...BASE,
      slice: "all" as const,
      coverage: { self: 0, public: 0, synthetic: 0 },
    };
    expect(RunFile.safeParse(empty).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { extractorAvailable } from "./preconditions.js";

/**
 * This precondition was a hardcoded `false` until the adapters existed. What it
 * must never become is a `true` that lets the harness measure a fake.
 */

const REAL = {
  STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
  STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
  STANDFAST_EMBEDDING_MODEL: "voyage-3",
  STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
  ANTHROPIC_API_KEY: "k",
  VOYAGE_API_KEY: "k",
};

describe("extractorAvailable", () => {
  it("is unmet on an unconfigured deployment", () => {
    // The ordinary answer, and the important one: with nothing configured the
    // ports are deterministic fakes.
    const got = extractorAvailable({});
    expect(got.met).toBe(false);
    expect(got.reason).toMatch(/fake extractor is not an extractor/);
  });

  it("is unmet when any single port is still a fake", () => {
    // A bag-of-words embedder behind a real extractor still produces a number,
    // and the number would be about the embedder.
    const got = extractorAvailable({
      ...REAL,
      STANDFAST_EMBEDDING_MODEL: "fake-bow-1",
    });
    expect(got.met).toBe(false);
    expect(got.reason).toMatch(/STANDFAST_EMBEDDING_MODEL/);
  });

  it("is unmet when the prompt version is unset", () => {
    // extractor_version would name a prompt nobody can identify, so the run
    // could not be reproduced even by the person who ran it.
    const { STANDFAST_EXTRACTION_PROMPT_VERSION, ...rest } = REAL;
    const got = extractorAvailable(rest);
    expect(got.met).toBe(false);
    expect(got.reason).toMatch(/PROMPT_VERSION/);
  });

  it("is unmet when a credential is missing, and says which", () => {
    const { VOYAGE_API_KEY, ...rest } = REAL;
    const got = extractorAvailable(rest);
    expect(got.met).toBe(false);
    expect(got.reason).toMatch(/VOYAGE_API_KEY/);
  });

  it("is met only when all three ports are providers with credentials", () => {
    const got = extractorAvailable(REAL);
    expect(got.met).toBe(true);
    expect(got.reason).toMatch(/claude-opus-5/);
  });

  it("does not check the egress allowlist", () => {
    // Deliberate. That refusal is the worker's, at start-up, and a security
    // control in two places is a security control that can disagree with
    // itself.
    expect(extractorAvailable(REAL).met).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { resolvePorts } from "./main.js";

describe("resolvePorts", () => {
  it("returns the fakes when nothing is configured", () => {
    const { ports } = resolvePorts({});
    expect(ports.extractor.id).toBe("fake-bullet-1");
    expect(ports.embedder.id).toBe("fake-bow-1");
    expect(ports.judge.id).toBe("fake-judge-1");
  });

  it("makes no outbound call, and says so", () => {
    // The default posture, asserted rather than assumed: a deployment nobody
    // configured to call anything calls nothing.
    const { egress } = resolvePorts({});
    expect(egress).toEqual([]);
  });

  it("refuses a real provider with no allowlist entry", () => {
    // The default posture: a destination that is not on the list is not called,
    // and the refusal is at start-up rather than at the first job.
    expect(() =>
      resolvePorts({
        STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
        STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
        STANDFAST_EMBEDDING_MODEL: "voyage-3",
        STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
      }),
    ).toThrow(/no egress allowlist entry for extraction/);
  });

  it("refuses a model the allowlist does not pin", () => {
    expect(() =>
      resolvePorts({
        STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
        STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
        STANDFAST_EMBEDDING_MODEL: "voyage-3",
        STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
        ANTHROPIC_API_KEY: "k",
        VOYAGE_API_KEY: "k",
        STANDFAST_EGRESS_ALLOWLIST: [
          "extraction https://api.anthropic.com claude-opus-4-8",
          "embedding https://api.voyageai.com voyage-3",
          "judge https://api.anthropic.com claude-sonnet-5",
        ].join(";"),
      }),
    ).toThrow(/allowlist pins claude-opus-4-8/);
  });

  it("refuses a missing credential at boot, not at the first job", () => {
    expect(() =>
      resolvePorts({
        STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
        STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
        STANDFAST_EMBEDDING_MODEL: "voyage-3",
        STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
        ANTHROPIC_API_KEY: "k",
        STANDFAST_EGRESS_ALLOWLIST: [
          "extraction https://api.anthropic.com claude-opus-5",
          "embedding https://api.voyageai.com voyage-3",
          "judge https://api.anthropic.com claude-sonnet-5",
        ].join(";"),
      }),
    ).toThrow(/VOYAGE_API_KEY is not set/);
  });

  it("refuses a prompt version that does not match this build", () => {
    // extractor_version would otherwise name a prompt nobody ran, and every
    // section extracted under it would be mislabelled rather than merely wrong.
    expect(() =>
      resolvePorts({
        STANDFAST_EXTRACTION_PROMPT_VERSION: "p0",
        STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
        STANDFAST_EMBEDDING_MODEL: "voyage-3",
        STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
        ANTHROPIC_API_KEY: "k",
        VOYAGE_API_KEY: "k",
        STANDFAST_EGRESS_ALLOWLIST: [
          "extraction https://api.anthropic.com claude-opus-5",
          "embedding https://api.voyageai.com voyage-3",
          "judge https://api.anthropic.com claude-sonnet-5",
        ].join(";"),
      }),
    ).toThrow(/name a prompt that never ran/);
  });

  it("refuses a half-real configuration", () => {
    // A real extractor with a fake embedder writes atoms whose vectors mean
    // nothing, and extractor_version records the pair as if somebody chose it.
    expect(() =>
      resolvePorts({
        STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
        STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
        ANTHROPIC_API_KEY: "k",
        STANDFAST_EGRESS_ALLOWLIST:
          "extraction https://api.anthropic.com claude-opus-5",
      }),
    ).toThrow(/mixed configuration/);
  });

  it("builds the three adapters when everything lines up", () => {
    const { ports, egress } = resolvePorts({
      STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
      STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
      STANDFAST_EMBEDDING_MODEL: "voyage-3",
      STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
      ANTHROPIC_API_KEY: "k",
      VOYAGE_API_KEY: "k",
      STANDFAST_EGRESS_ALLOWLIST: [
        "extraction https://api.anthropic.com claude-opus-5",
        "embedding https://api.voyageai.com voyage-3",
        "judge https://api.anthropic.com claude-sonnet-5",
      ].join(";"),
    });

    expect(ports.extractor.id).toBe("claude-opus-5");
    expect(ports.embedder.id).toBe("voyage-3");
    expect(ports.judge.id).toBe("claude-sonnet-5");
    expect(egress).toHaveLength(3);
  });

  it("refuses an allowlist entry this build would never use", () => {
    // Permission granted and not exercised is permission that outlives the
    // review which granted it. When 1d binds a real adapter this stops being a
    // refusal and becomes assertEgressAllowed.
    expect(() =>
      resolvePorts({
        STANDFAST_EGRESS_ALLOWLIST:
          "extraction https://api.example.com model-2026-01-01",
      }),
    ).toThrow(/permission nobody is using/);
  });

  it("refuses a malformed allowlist before constructing anything", () => {
    expect(() =>
      resolvePorts({
        STANDFAST_EGRESS_ALLOWLIST: "extraction https://a.example.com",
      }),
    ).toThrow(/purpose url model/);
  });

  it("refuses a reranking destination at the worker, too", () => {
    expect(() =>
      resolvePorts({
        STANDFAST_EGRESS_ALLOWLIST:
          "reranking https://r.example.com m-2026-01-01",
      }),
    ).toThrow(/rule 2/);
  });

  it("refuses one real port among fakes, in either direction", () => {
    // These two cases used to assert "this build has no such provider" — true
    // in 1c, when every port was a fake. 1d ships the adapters, so naming one
    // provider is no longer unsatisfiable; it is a configuration that would
    // half-work, which is worse. A real embedder with a fake extractor pairs
    // meaningful vectors with bullet-splitter statements, and extractor_version
    // would record the pair as though somebody had chosen it.
    expect(() =>
      resolvePorts({ STANDFAST_EMBEDDING_MODEL: "voyage-3" }),
    ).toThrow(/mixed configuration/);

    expect(() =>
      resolvePorts({ STANDFAST_EXTRACTION_MODEL: "claude-opus-5" }),
    ).toThrow(/mixed configuration/);
  });
});

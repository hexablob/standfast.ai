import { bandFor, cosineSimilarity, locateQuote } from "@standfast/core";
import { describe, expect, it } from "vitest";
import {
  AbsentQuoteExtractor,
  BagOfWordsEmbedder,
  BulletExtractor,
  ScriptedJudge,
} from "./fakes.js";
import { EMBEDDING_DIMENSIONS } from "./ports.js";

const NEVER_ABORTED = new AbortController().signal;

const SECTION = {
  headingPath: ["Conventions"],
  body: [
    "Some prose that is not a bullet.",
    "",
    "- Ship on Fridays",
    "- Never revert main directly",
    "",
    "More prose.",
  ].join("\n"),
};

async function candidatesOf(extractor: BulletExtractor, body: string) {
  return extractor.extract({ headingPath: [], body }, NEVER_ABORTED);
}

describe("BulletExtractor", () => {
  it("emits one candidate per bullet, in order", async () => {
    const got = await new BulletExtractor().extract(SECTION, NEVER_ABORTED);
    expect(got.map((c) => c.quote)).toEqual([
      "Ship on Fridays",
      "Never revert main directly",
    ]);
  });

  it("quotes text that is genuinely in the body, at a non-zero offset", async () => {
    // The whole reason the marker is excluded from the quote. A fake that
    // quoted the whole line would put every span at the start of a line and
    // the code-point arithmetic would never be exercised.
    const got = await new BulletExtractor().extract(SECTION, NEVER_ABORTED);
    for (const candidate of got) {
      const span = locateQuote(SECTION.body, candidate.quote);
      expect(span).not.toBeNull();
      expect(span?.start).toBeGreaterThan(0);
    }
  });

  it("emits nothing for a section with no bullets", async () => {
    expect(await candidatesOf(new BulletExtractor(), "Just prose.")).toEqual(
      [],
    );
  });

  it("is deterministic, including the kind it assigns", async () => {
    const a = await new BulletExtractor().extract(SECTION, NEVER_ABORTED);
    const b = await new BulletExtractor().extract(SECTION, NEVER_ABORTED);
    expect(a).toEqual(b);
  });

  it("fails on demand, so the retry path has something to be written against", async () => {
    const boom = new BulletExtractor({ failOnCall: 1 });
    await expect(boom.extract(SECTION, NEVER_ABORTED)).rejects.toThrow(
      /injected/,
    );
  });

  it("honours an abort signal", async () => {
    const aborted = AbortSignal.abort();
    await expect(
      new BulletExtractor().extract(SECTION, aborted),
    ).rejects.toThrow();
  });
});

describe("AbsentQuoteExtractor", () => {
  it("proposes one candidate the section cannot support", async () => {
    const got = await new AbsentQuoteExtractor().extract(
      SECTION,
      NEVER_ABORTED,
    );
    const locatable = got.filter(
      (c) => locateQuote(SECTION.body, c.quote) !== null,
    );
    expect(got).toHaveLength(3);
    expect(locatable).toHaveLength(2);
  });
});

describe("BagOfWordsEmbedder", () => {
  const embedder = new BagOfWordsEmbedder();

  it("returns one vector per input, in order, at the column's width", async () => {
    const got = await embedder.embed(["alpha", "beta"], NEVER_ABORTED);
    expect(got).toHaveLength(2);
    for (const vector of got) {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    }
    expect(got[0]).not.toEqual(got[1]);
  });

  it("is normalised, so cosine is the dot product", async () => {
    const [v] = await embedder.embed(["ship on fridays"], NEVER_ABORTED);
    const norm = Math.sqrt((v ?? []).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("puts identical statements in the duplicate band", async () => {
    const [a, b] = await embedder.embed(
      ["Deploys happen on Fridays.", "Deploys happen on Fridays."],
      NEVER_ABORTED,
    );
    expect(bandFor(cosineSimilarity(a ?? [], b ?? []))).toBe("duplicate");
  });

  it("puts disjoint statements in the distinct band", async () => {
    const [a, b] = await embedder.embed(
      ["Deploys happen on Fridays.", "Tabs indent Makefiles."],
      NEVER_ABORTED,
    );
    expect(bandFor(cosineSimilarity(a ?? [], b ?? []))).toBe("distinct");
  });

  it("lets a fixture steer a pair into the judge band by choosing words", async () => {
    // This is why the embedder hashes words rather than whole strings: a test
    // about the intermediate band can be written in English.
    const [a, b] = await embedder.embed(
      [
        "Deploys happen on Fridays and never on weekends.",
        "Deploys happen on Fridays and never on Mondays or holidays.",
      ],
      NEVER_ABORTED,
    );
    expect(bandFor(cosineSimilarity(a ?? [], b ?? []))).toBe("judge");
  });

  it("is deterministic across instances", async () => {
    const one = await new BagOfWordsEmbedder().embed(["x y z"], NEVER_ABORTED);
    const two = await new BagOfWordsEmbedder().embed(["x y z"], NEVER_ABORTED);
    expect(one).toEqual(two);
  });
});

describe("ScriptedJudge", () => {
  it("answers from the script", async () => {
    const judge = new ScriptedJudge(
      new Map([[ScriptedJudge.key("a", "b"), "same-claim" as const]]),
    );
    expect(
      await judge.adjudicate({ candidate: "a", incumbent: "b" }, NEVER_ABORTED),
    ).toBe("same-claim");
    expect(judge.calls).toEqual([{ candidate: "a", incumbent: "b" }]);
  });

  it("throws on an unscripted pair", async () => {
    // The assertion that keeps the judge inside its band. Any test that lets a
    // pair outside [0.80, 0.93) reach the judge fails here, whether or not it
    // was written to check that.
    const judge = new ScriptedJudge();
    await expect(
      judge.adjudicate({ candidate: "a", incumbent: "b" }, NEVER_ABORTED),
    ).rejects.toThrow(/unscripted pair/);
  });
});

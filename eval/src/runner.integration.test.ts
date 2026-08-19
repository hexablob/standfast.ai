import { sectionMarkdown } from "@standfast/core";
import { installQueue } from "@standfast/db/testing";
import { fakePorts } from "@standfast/worker/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Corpus } from "./corpus.js";
import type { LabelSet } from "./labels.js";
import { evalDatabaseUrl, RunnerError, runExtraction } from "./runner.js";

/**
 * The runner, driven end to end with deterministic fakes.
 *
 * The fakes are the point rather than a compromise. What this file proves is
 * the plumbing — that a corpus becomes documents, that every section is
 * extracted in a fixed order, that the atoms come back with provenance a person
 * can adjudicate, and that verdicts arrive null. None of that involves a model,
 * and `extractorAvailable()` keeps `pnpm eval extraction` from reporting a
 * number produced this way.
 */

const DOC_BODY = [
  "# Conventions",
  "",
  "- Deploys happen on Fridays",
  "- Tabs indent Makefiles",
  "",
  "# Prose",
  "",
  "This section states nothing in a bullet.",
  "",
].join("\n");

function corpusOf(): Corpus {
  const sections = sectionMarkdown(DOC_BODY);
  return {
    manifest: { version: 1, allowlist: [], documents: [] },
    revision: "test-revision",
    documents: [
      {
        id: "public/example",
        title: "Example",
        file: "public/example.md",
        tier: "public",
        split: "tuning",
        licence: "MIT",
        contentHash: "0".repeat(64),
        source: {
          kind: "public-repository",
          repository: "example/example",
          path: "README.md",
          commit: "0".repeat(40),
        },
        text: DOC_BODY,
        sections,
      },
    ],
  } as unknown as Corpus;
}

function labelsFor(corpus: Corpus): LabelSet[] {
  const document = corpus.documents[0];
  if (!document) throw new Error("fixture has no document");
  return [
    {
      version: 1,
      document: document.id,
      documentHash: document.contentHash,
      labeller: "test",
      labelledOn: "2026-08-10",
      blind: true,
      modelAssisted: false,
      sections: document.sections.map((section) => ({
        ordinal: section.ordinal,
        headingPath: section.headingPath,
        sectionHash: section.sectionHash,
        // One expected atom in the first section, none in the prose section —
        // an empty `expect` is a label saying the section states nothing.
        expect:
          section.headingPath[0] === "Conventions"
            ? [
                {
                  statement: "Deploys happen on Fridays.",
                  kind: "convention" as const,
                  quote: "Deploys happen on Fridays",
                },
              ]
            : [],
      })),
    },
  ];
}

let url: string;

beforeAll(async () => {
  const admin = process.env["DATABASE_URL"];
  if (!admin) throw new Error("DATABASE_URL is not set");
  // A distinct name, because the runner refuses to write to the database
  // anything else serves from — and this test is the assertion that it does.
  url = admin;
  process.env["STANDFAST_EVAL_DATABASE_URL"] = url;
  await installQueue(url);
}, 60_000);

afterAll(() => {
  process.env["STANDFAST_EVAL_DATABASE_URL"] = undefined;
});

describe("evalDatabaseUrl", () => {
  it("refuses to run without a database of its own", () => {
    expect(() => evalDatabaseUrl({})).toThrow(/STANDFAST_EVAL_DATABASE_URL/);
  });

  it("refuses the database everything else serves from", () => {
    // The mechanism behind "no configuration that would give it a path to a
    // production database". Reading a different variable is what makes that
    // structural; refusing when they match closes the copy-paste.
    expect(() =>
      evalDatabaseUrl({
        DATABASE_URL: "postgres://x/prod",
        STANDFAST_EVAL_DATABASE_URL: "postgres://x/prod",
      }),
    ).toThrow(/same as DATABASE_URL/);
  });

  it("accepts a database of its own", () => {
    expect(
      evalDatabaseUrl({
        DATABASE_URL: "postgres://x/prod",
        STANDFAST_EVAL_DATABASE_URL: "postgres://x/eval",
      }),
    ).toBe("postgres://x/eval");
  });
});

describe("runExtraction", () => {
  it("refuses a slice with an unlabelled section, and names it", async () => {
    // A run over unlabelled sections cannot be adjudicated, and its recall
    // denominator would silently be wrong rather than visibly missing.
    const corpus = corpusOf();
    await expect(
      runExtraction({
        corpus,
        labels: [],
        slice: "public",
        split: "tuning",
        extractorVersion: "ev1-test",
        ports: fakePorts(),
        databaseUrl: url,
      }),
    ).rejects.toThrow(/unlabelled/);
  });

  it("refuses a slice that matches no document", async () => {
    const corpus = corpusOf();
    await expect(
      runExtraction({
        corpus,
        labels: labelsFor(corpus),
        slice: "synthetic",
        split: "tuning",
        extractorVersion: "ev1-test",
        ports: fakePorts(),
        databaseUrl: url,
      }),
    ).rejects.toThrow(RunnerError);
  });

  it("extracts the corpus and returns atoms nobody has scored", async () => {
    const corpus = corpusOf();
    const result = await runExtraction({
      corpus,
      labels: labelsFor(corpus),
      slice: "public",
      split: "tuning",
      extractorVersion: `ev1-${Date.now()}`,
      ports: fakePorts(),
      databaseUrl: url,
    });

    // The bullet-splitter finds two bullets in the first section and nothing in
    // the prose one, which is the zero-candidate path taken with ordinary input.
    expect(result.adjudications).toHaveLength(2);
    for (const atom of result.adjudications) {
      // Keyed the same way the labels are, so a human scores by matching hashes
      // rather than by trusting two orderings to line up.
      expect(atom.sectionHash).toMatch(/^[0-9a-f]{64}$/);
      // Null, and it stays null. A runner that filled this in would be the
      // system grading itself.
      expect(atom.verdict).toBeNull();
    }

    // The quote a human adjudicates against is the one stored, not a
    // paraphrase — this is what makes the worksheet checkable by reading.
    expect(result.adjudications.map((a) => a.quote).sort()).toEqual([
      "Deploys happen on Fridays",
      "Tabs indent Makefiles",
    ]);

    // Recall's denominator comes from the labels, not from what was emitted.
    expect(result.expectedAtomIds).toHaveLength(1);

    // Coverage is evidence for the slice claim, counted per tier.
    expect(result.coverage).toEqual({ self: 0, public: 2, synthetic: 0 });
    expect(result.documents).toEqual(["public/example"]);
  }, 60_000);

  it("is reproducible: two runs of the same corpus agree", async () => {
    // The property the fixed processing order exists for. If this ever goes
    // intermittent, dedup ordering is the first thing to look at.
    const corpus = corpusOf();
    const once = await runExtraction({
      corpus,
      labels: labelsFor(corpus),
      slice: "public",
      split: "tuning",
      extractorVersion: `ev1-${Date.now()}-a`,
      ports: fakePorts(),
      databaseUrl: url,
    });
    const twice = await runExtraction({
      corpus,
      labels: labelsFor(corpus),
      slice: "public",
      split: "tuning",
      extractorVersion: `ev1-${Date.now()}-b`,
      ports: fakePorts(),
      databaseUrl: url,
    });

    expect(twice.adjudications).toEqual(once.adjudications);
  }, 60_000);
});

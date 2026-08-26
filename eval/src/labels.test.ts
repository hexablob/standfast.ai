import { contentHash, sectionMarkdown } from "@standfast/core";
import { describe, expect, it } from "vitest";
import type { Corpus, LoadedDocument } from "./corpus.js";
import { corpusRevision } from "./corpus.js";
import type { LabelSet } from "./labels.js";
import {
  checkLabels,
  coverage,
  diagnoseQuote,
  expectations,
  expectedAtomId,
  labelFileName,
  UNREAD,
} from "./labels.js";
import { labelSkeleton } from "./skeleton.js";

const TEXT = `# Stack

Postgres 16 with pgvector is settled.

## Queue

pg-boss, and transactional enqueue is mandatory.
`;

function document(text = TEXT): LoadedDocument {
  return {
    id: "self/stack.md",
    tier: "self",
    file: "self/stack.md",
    title: "Stack",
    licence: "AGPL-3.0-only",
    contentHash: contentHash(text),
    split: "tuning",
    source: {
      kind: "this-repository",
      path: "docs/stack.md",
      commit: "0".repeat(40),
    },
    text,
    sections: sectionMarkdown(text),
  };
}

function corpusOf(...documents: LoadedDocument[]): Corpus {
  const manifest = { version: 1 as const, allowlist: [], documents };
  return { manifest, documents, revision: corpusRevision(manifest) };
}

function errorsOf(corpus: Corpus, labels: LabelSet[]): string[] {
  return checkLabels(corpus, labels)
    .filter((p) => p.level === "error")
    .map((p) => p.message);
}

/** Takes one section out of `UNREAD` with the positive "states nothing" label. */
function withDecided(set: LabelSet, index: number): LabelSet {
  return {
    ...set,
    sections: set.sections.map((section, i) =>
      i === index ? { ...section, expect: [] } : section,
    ),
  };
}

function warningsOf(corpus: Corpus, labels: LabelSet[]): string[] {
  return checkLabels(corpus, labels)
    .filter((p) => p.level === "warning")
    .map((p) => p.message);
}

describe("expectedAtomId", () => {
  it("keys on the section hash, so a reordered document keeps its ids", () => {
    const hash = "a".repeat(64);
    const section = {
      ordinal: 3,
      headingPath: [],
      sectionHash: hash,
      expect: [],
    };
    const moved = { ...section, ordinal: 1 };

    expect(expectedAtomId(section, 0)).toBe(expectedAtomId(moved, 0));
    expect(expectedAtomId(section, 0)).not.toBe(expectedAtomId(section, 1));
  });
});

describe("labelFileName", () => {
  it("flattens the document id so the file lives in one directory", () => {
    expect(labelFileName("self/stack.md", "ana")).toBe(
      "self__stack.md.ana.json",
    );
  });
});

describe("labelSkeleton", () => {
  it("lists every section as unread, blind and unassisted", () => {
    const doc = document();
    const skeleton = labelSkeleton(doc, "ana", "2026-08-07");

    expect(skeleton.sections).toHaveLength(doc.sections.length);
    expect(skeleton.sections.every((s) => s.expect === UNREAD)).toBe(true);
    expect(skeleton.blind).toBe(true);
    expect(skeleton.modelAssisted).toBe(false);
    expect(skeleton.documentHash).toBe(doc.contentHash);
  });

  it("asserts nothing about any section until someone types over it", () => {
    // The defect this format exists to remove: a skeleton whose every `expect`
    // was `[]` said "this section states nothing" about a document nobody had
    // read, and coverage counted every one of those as work done.
    const doc = document();
    const skeleton = labelSkeleton(doc, "ana", "2026-08-07");

    expect(skeleton.sections.every((s) => expectations(s) === null)).toBe(true);
    expect(coverage(corpusOf(doc), [skeleton])[0]?.labellers[0]?.labelled).toBe(
      0,
    );
  });

  it("produces a label set the checker accepts", () => {
    const doc = document();

    expect(
      errorsOf(corpusOf(doc), [labelSkeleton(doc, "ana", "2026-08-07")]),
    ).toEqual([]);
  });
});

describe("checkLabels", () => {
  it("rejects a label set for a document not in the corpus", () => {
    const doc = document();
    const set = {
      ...labelSkeleton(doc, "ana", "2026-08-07"),
      document: "self/gone.md",
    };

    expect(errorsOf(corpusOf(doc), [set]).join()).toMatch(/no corpus document/);
  });

  it("names the sections an edit orphaned, by heading path", () => {
    const before = document();
    const labels = labelSkeleton(before, "ana", "2026-08-07");
    const after = document(TEXT.replace("pg-boss", "a job queue"));

    const message = errorsOf(corpusOf(after), [labels]).join();

    expect(message).toMatch(/need re-labelling/);
    expect(message).toMatch(/Queue/);
  });

  it("rejects a quote that is not in the section body", () => {
    const doc = document();
    const skeleton = labelSkeleton(doc, "ana", "2026-08-07");
    const first = skeleton.sections[0];
    if (!first) {
      throw new Error("the fixture has no sections");
    }
    const set: LabelSet = {
      ...skeleton,
      sections: [
        {
          ...first,
          expect: [
            {
              statement: "Postgres is the database.",
              kind: "decision",
              quote: "MySQL 8 with a vector extension",
            },
          ],
        },
      ],
    };

    expect(errorsOf(corpusOf(doc), [set]).join()).toMatch(
      /not in the section body/,
    );
  });

  it("rejects the same section labelled twice", () => {
    const doc = document();
    const skeleton = labelSkeleton(doc, "ana", "2026-08-07");
    const first = skeleton.sections[0];
    if (!first) {
      throw new Error("the fixture has no sections");
    }

    expect(
      errorsOf(corpusOf(doc), [
        { ...skeleton, sections: [first, first] },
      ]).join(),
    ).toMatch(/labelled twice/);
  });

  it("only warns when the document moved but no labelled section did", () => {
    const doc = document();
    const stale = {
      ...labelSkeleton(doc, "ana", "2026-08-07"),
      documentHash: "f".repeat(64),
    };

    expect(errorsOf(corpusOf(doc), [stale])).toEqual([]);
    expect(warningsOf(corpusOf(doc), [stale]).join()).toMatch(
      /documentHash is behind/,
    );
  });

  it("warns that a non-blind label set contaminates every run using it", () => {
    const doc = document();
    const graded = { ...labelSkeleton(doc, "ana", "2026-08-07"), blind: false };

    expect(warningsOf(corpusOf(doc), [graded]).join()).toMatch(/contaminated/);
  });

  it("warns that a model-assisted label set has to be marked as such", () => {
    const doc = document();
    const assisted = {
      ...labelSkeleton(doc, "ana", "2026-08-07"),
      modelAssisted: true,
    };

    expect(warningsOf(corpusOf(doc), [assisted]).join()).toMatch(
      /model-assisted/,
    );
  });
});

describe("coverage", () => {
  it("counts a section labelled empty as labelled, and an unread one as not", () => {
    // The distinction the whole recall figure rests on: "this section states
    // nothing" is a judgement, "I have not read this section" is not.
    const doc = document();
    const skeleton = labelSkeleton(doc, "ana", "2026-08-07");
    const decided = withDecided(skeleton, 0);

    const [fresh] = coverage(corpusOf(doc), [skeleton]);
    const [some] = coverage(corpusOf(doc), [decided]);

    expect(fresh?.labellers[0]?.labelled).toBe(0);
    expect(fresh?.labellers[0]?.unread).toBe(doc.sections.length);
    expect(some?.labellers[0]?.labelled).toBe(1);
    expect(some?.labellers[0]?.unread).toBe(doc.sections.length - 1);
  });

  it("moves by exactly one when exactly one section is decided", () => {
    const doc = document();
    const skeleton = labelSkeleton(doc, "ana", "2026-08-07");

    const before = coverage(corpusOf(doc), [skeleton])[0]?.labellers[0];
    const after = coverage(corpusOf(doc), [withDecided(skeleton, 0)])[0]
      ?.labellers[0];

    expect((after?.labelled ?? 0) - (before?.labelled ?? 0)).toBe(1);
    expect((before?.unread ?? 0) - (after?.unread ?? 0)).toBe(1);
  });

  it("lists a document with no labeller as covered by nobody", () => {
    expect(coverage(corpusOf(document()), [])[0]?.labellers).toEqual([]);
  });
});

describe("expectations", () => {
  it("separates silence from the label that says the section states nothing", () => {
    const hash = "a".repeat(64);
    const base = { ordinal: 0, headingPath: [], sectionHash: hash };

    expect(expectations({ ...base, expect: UNREAD })).toBeNull();
    expect(expectations({ ...base, expect: [] })).toEqual([]);
  });
});

describe("diagnoseQuote", () => {
  // A section body as it lives in the corpus: hard-wrapped source.
  const BODY =
    "Postgres 16 with pgvector is settled, and the queue\nis pg-boss with transactional enqueue.";

  it("passes an exact substring", () => {
    expect(diagnoseQuote(BODY, "pgvector is settled")).toEqual({
      kind: "exact",
    });
  });

  it("names a whitespace-only near-miss and prints the pasteable text", () => {
    // What a human gets by copying out of the rendered document: the source's
    // newline arrives as a space.
    const copied = "the queue is pg-boss";

    const diagnosis = diagnoseQuote(BODY, copied);

    expect(diagnosis.kind).toBe("whitespace");
    if (diagnosis.kind !== "whitespace") {
      throw new Error("expected a whitespace near-miss");
    }
    expect(diagnosis.exact).toBe("the queue\nis pg-boss");
    // The point of printing it: pasting it makes the exact check pass.
    expect(BODY.includes(diagnosis.exact)).toBe(true);
  });

  it("tolerates a run of whitespace of any length", () => {
    const body = "alpha\n\n   beta";

    expect(diagnoseQuote(body, "alpha beta")).toEqual({
      kind: "whitespace",
      exact: "alpha\n\n   beta",
    });
  });

  it("says how far a genuinely wrong quote matches", () => {
    const diagnosis = diagnoseQuote(BODY, "Postgres 16 with MySQL");

    expect(diagnosis).toEqual({
      kind: "absent",
      matched: "Postgres 16 with ",
    });
  });

  it("says so when nothing matches from the first character", () => {
    expect(diagnoseQuote(BODY, "zzz")).toEqual({ kind: "absent", matched: "" });
  });

  it("never rewrites the label — it only reports", () => {
    // The exact check stays the thing that passes or fails: a stored atom is
    // verified byte for byte against its section body, so an auto-corrected
    // quote would encode an atom that could never exist.
    const copied = "the queue is pg-boss";

    expect(BODY.includes(copied)).toBe(false);
    expect(diagnoseQuote(BODY, copied).kind).not.toBe("exact");
  });
});

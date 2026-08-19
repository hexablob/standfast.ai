import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCorpus, corpusRevision, loadCorpus } from "./corpus.js";
import { checkLabels, loadLabels } from "./labels.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the shipped corpus", () => {
  const corpus = loadCorpus(ROOT);

  it("has no errors", () => {
    // The same check CI runs. It is here as well so a corpus edit that
    // orphans a label fails on a laptop before it fails on a pull request.
    const errors = checkCorpus(corpus).filter((p) => p.level === "error");

    expect(errors).toEqual([]);
  });

  it("has no label errors", () => {
    const errors = checkLabels(corpus, loadLabels(ROOT)).filter(
      (p) => p.level === "error",
    );

    expect(errors).toEqual([]);
  });

  it("holds a non-empty held-out split", () => {
    // This test used to assert the opposite — that `check` warns the split is
    // empty — and said that whoever filled the split should replace it. The
    // split is filled, so here is the replacement: the same guard pointed the
    // other way. A corpus refresh that empties held-out fails here rather than
    // silently returning the harness to a state where no number it produces
    // may be reported as final (docs/12-evaluation.md, contamination rule 3).
    const heldOut = corpus.documents.filter((d) => d.split === "held-out");
    expect(heldOut.length).toBeGreaterThan(0);

    const warnings = checkCorpus(corpus).filter((p) => p.level === "warning");
    expect(warnings.map((p) => p.message).join("\n")).not.toMatch(/held-out/);
  });

  it("admits every tier-2 repository by allowlist, with a licence", () => {
    // Allowlist, never denylist (docs/02-principles.md, 9). checkCorpus already
    // refuses a public document whose repository is absent; this asserts the
    // list is populated rather than vacuously satisfied by having no public
    // documents at all.
    const publicDocs = corpus.documents.filter((d) => d.tier === "public");
    expect(publicDocs.length).toBeGreaterThan(0);

    for (const doc of publicDocs) {
      // A public-tier document always carries a repository; the union says so.
      const source = doc.source;
      expect(source.kind).toBe("public-repository");
      if (source.kind !== "public-repository") continue;

      const entry = corpus.manifest.allowlist.find(
        (a) => a.repository === source.repository,
      );
      expect(entry?.licence).toBe(doc.licence);
    }
  });

  it("splits every document into sections", () => {
    for (const document of corpus.documents) {
      expect(document.sections.length).toBeGreaterThan(0);
    }
  });
});

describe("corpusRevision", () => {
  const document = {
    id: "self/a.md",
    tier: "self" as const,
    file: "self/a.md",
    title: "A",
    licence: "AGPL-3.0-only",
    contentHash: "a".repeat(64),
    split: "tuning" as const,
    source: {
      kind: "this-repository" as const,
      path: "docs/a.md",
      commit: "0".repeat(40),
    },
  };

  it("is stable for the same documents and hashes", () => {
    const manifest = {
      version: 1 as const,
      allowlist: [],
      documents: [document],
    };

    expect(corpusRevision(manifest)).toBe(corpusRevision(manifest));
  });

  it("moves when a document's content moves", () => {
    const before = {
      version: 1 as const,
      allowlist: [],
      documents: [document],
    };
    const after = {
      ...before,
      documents: [{ ...document, contentHash: "b".repeat(64) }],
    };

    expect(corpusRevision(after)).not.toBe(corpusRevision(before));
  });

  it("moves when a document is added", () => {
    const before = {
      version: 1 as const,
      allowlist: [],
      documents: [document],
    };
    const after = {
      ...before,
      documents: [document, { ...document, id: "self/b.md" }],
    };

    expect(corpusRevision(after)).not.toBe(corpusRevision(before));
  });

  it("does not move when the repository does", () => {
    // A run pins the documents it measured, not the commit it ran at. If the
    // revision tracked the repository SHA, no two runs would ever compare.
    const manifest = {
      version: 1 as const,
      allowlist: [],
      documents: [document],
    };
    const moved = {
      ...manifest,
      documents: [
        { ...document, source: { ...document.source, commit: "1".repeat(40) } },
      ],
    };

    expect(corpusRevision(moved)).toBe(corpusRevision(manifest));
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash, type Section, sectionMarkdown } from "@standfast/core";
import { z } from "zod";

const HEX64 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where a corpus document came from.
 *
 * `this-repository` still records a commit, even though the file is copied in
 * rather than read from `docs/`. The copy is the point: a corpus is a snapshot,
 * and editing `docs/02-principles.md` must not silently invalidate labels
 * written against the sentence it used to contain. The commit says which
 * snapshot, so refreshing the corpus is a deliberate act with a diff.
 */
const Source = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("this-repository"),
    path: z.string().min(1),
    commit: z.string().regex(SHA1),
  }),
  z.object({
    kind: z.literal("public-repository"),
    repository: z.string().min(1),
    path: z.string().min(1),
    commit: z.string().regex(SHA1),
  }),
  z.object({
    kind: z.literal("written-for-purpose"),
    author: z.string().min(1),
    writtenOn: z.string().regex(ISO_DATE),
  }),
]);

const TIERS = ["self", "public", "synthetic"] as const;
const SPLITS = ["tuning", "held-out"] as const;

export type Tier = (typeof TIERS)[number];
export type Split = (typeof SPLITS)[number];

const CorpusDocument = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/),
  tier: z.enum(TIERS),
  file: z.string().min(1),
  title: z.string().min(1),
  licence: z.string().min(1),
  contentHash: z.string().regex(HEX64),
  split: z.enum(SPLITS),
  source: Source,
});

const CorpusManifest = z.object({
  version: z.literal(1),

  // Allowlist rather than denylist, for the reason in docs/02-principles.md
  // (9): a denylist has to anticipate the licence nobody thought to exclude.
  // A tier-2 document whose repository is not listed here is refused.
  allowlist: z.array(
    z.object({
      repository: z.string().min(1),
      licence: z.string().min(1),
      approvedOn: z.string().regex(ISO_DATE),
    }),
  ),

  documents: z.array(CorpusDocument),
});

export type CorpusDocument = z.infer<typeof CorpusDocument>;
export type CorpusManifest = z.infer<typeof CorpusManifest>;

/** A corpus document with its text and the sections the pipeline would see. */
export type LoadedDocument = CorpusDocument & {
  text: string;
  sections: Section[];
};

export type Corpus = {
  manifest: CorpusManifest;
  documents: LoadedDocument[];
  /** Identity of the corpus as a whole. Recorded in every committed run. */
  revision: string;
};

/**
 * A content address for the corpus: the document ids and their hashes, in
 * manifest order.
 *
 * Not the repository SHA. A run has to pin the documents it measured, and the
 * repository moves for reasons that have nothing to do with the corpus — so a
 * repository SHA would make every run look incomparable with every other one.
 */
export function corpusRevision(manifest: CorpusManifest): string {
  const hash = createHash("sha256");
  for (const document of manifest.documents) {
    hash.update(`${document.id}\n${document.contentHash}\n`, "utf8");
  }
  return hash.digest("hex").slice(0, 16);
}

export function loadCorpus(root: string): Corpus {
  const manifestPath = join(root, "corpus", "manifest.json");
  const manifest = CorpusManifest.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );

  const documents = manifest.documents.map((document) => {
    const text = readFileSync(join(root, "corpus", document.file), "utf8");
    return { ...document, text, sections: sectionMarkdown(text) };
  });

  return { manifest, documents, revision: corpusRevision(manifest) };
}

export type Problem = { level: "error" | "warning"; message: string };

/**
 * Everything about the corpus that can be checked without a human, a model or a
 * database. Runs on every pull request.
 */
export function checkCorpus(corpus: Corpus): Problem[] {
  const problems: Problem[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const allowed = new Map(
    corpus.manifest.allowlist.map((entry) => [entry.repository, entry]),
  );

  for (const document of corpus.documents) {
    if (seenIds.has(document.id)) {
      problems.push({
        level: "error",
        message: `corpus: duplicate document id ${document.id}`,
      });
    }
    seenIds.add(document.id);

    if (seenFiles.has(document.file)) {
      problems.push({
        level: "error",
        message: `corpus: two documents claim the file ${document.file}`,
      });
    }
    seenFiles.add(document.file);

    const actual = contentHash(document.text);
    if (actual !== document.contentHash) {
      problems.push({
        level: "error",
        message:
          `corpus: ${document.id} has changed since it was recorded ` +
          `(manifest ${document.contentHash.slice(0, 12)}, ` +
          `file ${actual.slice(0, 12)}). Update the manifest and re-run ` +
          `'pnpm eval check' to see which labels the change orphaned.`,
      });
    }

    if (document.sections.length === 0) {
      problems.push({
        level: "error",
        message: `corpus: ${document.id} yields no sections`,
      });
    }

    // The allowlist is a licence gate, and a gate that is only consulted when
    // somebody remembers is not a gate.
    if (document.tier === "public") {
      if (document.source.kind !== "public-repository") {
        problems.push({
          level: "error",
          message: `corpus: ${document.id} is tier 'public' but its source is not a public repository`,
        });
      } else {
        const entry = allowed.get(document.source.repository);
        if (!entry) {
          problems.push({
            level: "error",
            message: `corpus: ${document.source.repository} is not on the allowlist`,
          });
        } else if (entry.licence !== document.licence) {
          problems.push({
            level: "error",
            message:
              `corpus: ${document.id} claims licence ${document.licence}, ` +
              `but the allowlist records ${entry.licence} for its repository`,
          });
        }
      }
    }

    if (
      document.tier === "synthetic" &&
      document.source.kind !== "written-for-purpose"
    ) {
      problems.push({
        level: "error",
        message: `corpus: ${document.id} is tier 'synthetic' but does not record an author`,
      });
    }
  }

  // A held-out split is the third contamination rule. An empty one is not a
  // neutral state: it means every number this harness produces was measured on
  // the same documents the prompts were fitted to.
  if (!corpus.documents.some((document) => document.split === "held-out")) {
    problems.push({
      level: "warning",
      message:
        "corpus: the held-out split is empty. Until it is not, no number " +
        "from this harness may be reported as final (docs/12-evaluation.md, " +
        "contamination rule 3).",
    });
  }

  return problems;
}

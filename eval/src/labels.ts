import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Corpus, LoadedDocument, Problem } from "./corpus.js";

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ATOM_KINDS = ["decision", "convention", "constraint"] as const;
export type AtomKind = (typeof ATOM_KINDS)[number];

const ExpectedAtom = z.object({
  statement: z.string().min(1),
  kind: z.enum(ATOM_KINDS),

  // Verbatim, from the section body. Checked, for the same reason the database
  // checks it on write: a quote nobody verified is a quote that drifts.
  quote: z.string().min(1),
});

const SectionLabel = z.object({
  ordinal: z.number().int().min(0),
  headingPath: z.array(z.string()),
  sectionHash: z.string().regex(HEX64),

  // An empty list is a label, not a gap: it says this section states no
  // decision, convention or constraint. A section with no entry at all is
  // unlabelled. Collapsing the two would make recall unmeasurable — a missed
  // atom and a section nobody read would count the same.
  expect: z.array(ExpectedAtom),
});

const LabelSet = z.object({
  version: z.literal(1),
  document: z.string().min(1),

  // The corpus document this was written against. A mismatch means the corpus
  // moved under the labels, and `checkLabels` says exactly which sections it
  // took with it.
  documentHash: z.string().regex(HEX64),

  labeller: z.string().min(1),
  labelledOn: z.string().regex(ISO_DATE),

  // The labeller had not seen the extractor's output. False is permitted and
  // reported: a graded label set anchors on what is present and is
  // structurally incapable of noticing what is absent, so its recall figure is
  // meaningless and its precision figure is inflated.
  blind: z.boolean(),

  // A model proposed the candidates and a human accepted or rejected them.
  // Off by default; any run that includes such a set is marked in its output.
  modelAssisted: z.boolean(),

  sections: z.array(SectionLabel),
});

export type ExpectedAtom = z.infer<typeof ExpectedAtom>;
export type SectionLabel = z.infer<typeof SectionLabel>;
export type LabelSet = z.infer<typeof LabelSet>;

/** `sectionHash#index` — stable identity for one expected atom. */
export function expectedAtomId(section: SectionLabel, index: number): string {
  return `${section.sectionHash}#${index}`;
}

export function loadLabels(root: string): LabelSet[] {
  const directory = join(root, "labels");
  const files = readdirSync(directory)
    // `edits.<labeller>.json` are the reconciliation corpus's verdicts and
    // carry a different schema (edits.ts). Section label files always contain
    // `__` (a document id has a `/`), so the prefixes cannot collide.
    .filter((name) => name.endsWith(".json") && !/^edits\./.test(name))
    .sort();

  return files.map((name) => {
    const parsed = LabelSet.safeParse(
      JSON.parse(readFileSync(join(directory, name), "utf8")),
    );
    if (!parsed.success) {
      throw new Error(
        `labels/${name} is not a valid label set:\n${parsed.error.message}`,
      );
    }
    return parsed.data;
  });
}

/** `labels/<document id with / replaced>.<labeller>.json` */
export function labelFileName(document: string, labeller: string): string {
  return `${document.replace(/\//g, "__")}.${labeller}.json`;
}

export function checkLabels(corpus: Corpus, labels: LabelSet[]): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map(corpus.documents.map((d) => [d.id, d]));

  for (const set of labels) {
    const name = labelFileName(set.document, set.labeller);
    const document = byId.get(set.document);
    if (!document) {
      problems.push({
        level: "error",
        message: `${name}: no corpus document with id ${set.document}`,
      });
      continue;
    }
    problems.push(...checkLabelSet(name, document, set));
  }

  return problems;
}

function checkLabelSet(
  name: string,
  document: LoadedDocument,
  set: LabelSet,
): Problem[] {
  const problems: Problem[] = [];
  const sections = new Map(document.sections.map((s) => [s.sectionHash, s]));
  const orphaned: string[] = [];

  for (const label of set.sections) {
    const section = sections.get(label.sectionHash);
    if (!section) {
      orphaned.push(
        label.headingPath.join(" › ") || `(preamble, ordinal ${label.ordinal})`,
      );
      continue;
    }

    // The hash already fixes the body and the heading path; the ordinal is
    // recorded for the labeller's benefit and can drift when a document is
    // reordered. Worth saying out loud, worth nothing more than a warning.
    if (section.ordinal !== label.ordinal) {
      problems.push({
        level: "warning",
        message:
          `${name}: section '${label.headingPath.join(" › ")}' moved from ` +
          `ordinal ${label.ordinal} to ${section.ordinal}`,
      });
    }

    for (const [index, expected] of label.expect.entries()) {
      if (!section.body.includes(expected.quote)) {
        problems.push({
          level: "error",
          message:
            `${name}: expected atom ${index} of section ` +
            `'${label.headingPath.join(" › ")}' quotes text that is not in ` +
            `the section body`,
        });
      }
    }
  }

  const duplicates =
    set.sections.length !==
    new Set(set.sections.map((s) => s.sectionHash)).size;
  if (duplicates) {
    problems.push({
      level: "error",
      message: `${name}: the same section is labelled twice`,
    });
  }

  if (orphaned.length > 0) {
    problems.push({
      level: "error",
      message:
        `${name}: ${orphaned.length} labelled section(s) no longer exist in ` +
        `the corpus document and need re-labelling — ${orphaned.join("; ")}`,
    });
  } else if (set.documentHash !== document.contentHash) {
    // Every labelled section survived the edit, so nothing is stale; the
    // recorded hash is simply behind. Worth fixing, not worth failing.
    problems.push({
      level: "warning",
      message:
        `${name}: documentHash is behind the corpus (no labelled section ` +
        `moved). Update it to ${document.contentHash.slice(0, 12)}….`,
    });
  }

  if (!set.blind) {
    problems.push({
      level: "warning",
      message: `${name}: not blind-first — any run using it is contaminated`,
    });
  }
  if (set.modelAssisted) {
    problems.push({
      level: "warning",
      message: `${name}: model-assisted — any run using it is marked as such`,
    });
  }

  return problems;
}

export type Coverage = {
  document: string;
  tier: string;
  split: string;
  sections: number;
  labellers: { labeller: string; labelled: number }[];
};

export function coverage(corpus: Corpus, labels: LabelSet[]): Coverage[] {
  return corpus.documents.map((document) => ({
    document: document.id,
    tier: document.tier,
    split: document.split,
    sections: document.sections.length,
    labellers: labels
      .filter((set) => set.document === document.id)
      .map((set) => ({
        labeller: set.labeller,
        labelled: set.sections.length,
      })),
  }));
}

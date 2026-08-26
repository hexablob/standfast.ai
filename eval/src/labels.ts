import { join } from "node:path";
import { z } from "zod";
import type { Corpus, LoadedDocument, Problem } from "./corpus.js";
import { type Loaded, loadDirectory } from "./parse.js";

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

/**
 * What a freshly generated skeleton puts in every `expect`, and what a labeller
 * overwrites.
 *
 * The distinction docs/12-evaluation.md draws — an empty list is the positive
 * label "this section states nothing", a section nobody read is unlabelled — is
 * the difference between a measurable recall denominator and an unmeasurable
 * one. Carrying it in the *presence* of an entry made it a duty of human
 * memory, repeated once per section, with nothing to catch a lapse. Carrying it
 * in the *value* makes it a fact of the file: a skeleton asserts nothing until
 * someone types over this marker, and `[]` cannot be reached by inaction.
 */
export const UNREAD = "unread";

const SectionLabel = z.object({
  ordinal: z.number().int().min(0),
  headingPath: z.array(z.string()),
  sectionHash: z.string().regex(HEX64),

  // `"unread"` is silence: nobody has read this section, and it counts towards
  // nothing. An empty list is a label, not a gap: it says this section states no
  // decision, convention or constraint, and it counts. Collapsing the two would
  // make recall unmeasurable — a missed atom and a section nobody read would
  // count the same.
  expect: z.union([z.literal(UNREAD), z.array(ExpectedAtom)]),
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

/**
 * The atoms a labeller wrote for this section, or null when nobody read it.
 *
 * Every consumer of `expect` goes through here, so "an untouched entry is not a
 * label" is one branch rather than a convention each call site has to remember.
 * Null and `[]` are both falsy-looking and mean opposite things, which is why
 * this returns null rather than an empty array for silence.
 */
export function expectations(section: SectionLabel): ExpectedAtom[] | null {
  return section.expect === UNREAD ? null : section.expect;
}

/** Sections of this set a human has actually decided about. */
export function labelledSections(set: LabelSet): SectionLabel[] {
  return set.sections.filter((section) => section.expect !== UNREAD);
}

/** Sections still carrying the skeleton's marker — silence, not a label. */
export function unreadSections(set: LabelSet): SectionLabel[] {
  return set.sections.filter((section) => section.expect === UNREAD);
}

/**
 * Every section label set under `labels/`, with a Problem for each one that is
 * malformed rather than a throw on the first.
 *
 * One typo used to blank the whole of `check` — corpus listing, coverage and
 * agreement with it — and named the site only by array index. Every other file
 * still loads, and `check` reports the bad one by file and heading.
 */
export function loadLabels(root: string): Loaded<LabelSet> {
  return loadDirectory(
    join(root, "labels"),
    // `edits.<labeller>.json` are the reconciliation corpus's verdicts and
    // carry a different schema (edits.ts). Section label files always contain
    // `__` (a document id has a `/`), so the prefixes cannot collide.
    (name) => !/^edits\./.test(name),
    LabelSet,
    (name) => `labels/${name}`,
  );
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

/**
 * Why an expected quote is not a substring of its section body.
 *
 * The check itself stays exact and must: a stored atom is verified byte for
 * byte against its section body by a database trigger, so a label quote that is
 * not an exact substring encodes an atom that could never exist. Only the
 * diagnosis improves. Across a corpus of a few hundred sections the dominant
 * cause is transcription, not judgement — a quote copied out of the rendered
 * document, where the hard wrap in the source became a single space — and
 * "quotes text that is not in the section body" blames the quote for it.
 *
 * Nothing here rewrites the label. `exact` is printed for the human to paste;
 * choosing what an atom quotes is theirs.
 */
export type QuoteDiagnosis =
  | { kind: "exact" }
  | { kind: "whitespace"; exact: string }
  | { kind: "absent"; matched: string };

/** Runs of whitespace collapsed to one space, with a map back to the original. */
function collapse(text: string): { flat: string; offsets: number[] } {
  let flat = "";
  const offsets: number[] = [];
  let inRun = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (/\s/.test(char)) {
      if (!inRun && flat.length > 0) {
        flat += " ";
        offsets.push(i);
      }
      inRun = true;
      continue;
    }
    inRun = false;
    flat += char;
    offsets.push(i);
  }
  // Trailing space, if any, is not part of a match worth reporting.
  while (flat.endsWith(" ")) {
    flat = flat.slice(0, -1);
    offsets.pop();
  }
  return { flat, offsets };
}

export function diagnoseQuote(body: string, quote: string): QuoteDiagnosis {
  if (body.includes(quote)) {
    return { kind: "exact" };
  }

  const wide = collapse(body);
  const narrow = collapse(quote);
  const at = narrow.flat === "" ? -1 : wide.flat.indexOf(narrow.flat);
  if (at >= 0) {
    // Same characters, different whitespace. Map the match back through the
    // offset table to recover the bytes the body actually holds.
    const start = wide.offsets[at] as number;
    const last = wide.offsets[at + narrow.flat.length - 1] as number;
    return { kind: "whitespace", exact: body.slice(start, last + 1) };
  }

  // Not a whitespace problem. Report how far the quote does match, so the
  // human sees where it diverges instead of re-reading the whole section.
  // ponytail: linear scan over prefix lengths — quotes are a sentence or two.
  let matched = "";
  for (let length = 1; length <= narrow.flat.length; length += 1) {
    const prefix = narrow.flat.slice(0, length);
    if (!wide.flat.includes(prefix)) {
      break;
    }
    matched = prefix;
  }
  return { kind: "absent", matched };
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

    const expected = expectations(label);
    if (expected === null) {
      // Untouched. Not a label, so nothing to verify and nothing to count;
      // `coverage` reports how many of these are outstanding.
      continue;
    }

    for (const [index, atom] of expected.entries()) {
      const diagnosis = diagnoseQuote(section.body, atom.quote);
      if (diagnosis.kind === "exact") {
        continue;
      }
      const where =
        `${name}: expected atom ${index} of section ` +
        `'${label.headingPath.join(" › ")}'`;
      problems.push({
        level: "error",
        message:
          diagnosis.kind === "whitespace"
            ? `${where} quotes the right text with the wrong whitespace. The ` +
              "body hard-wraps where the quote has a space. Paste this " +
              `instead:\n      ${JSON.stringify(diagnosis.exact)}`
            : `${where} quotes text that is not in the section body. It ` +
              (diagnosis.matched === ""
                ? "does not match from the first character."
                : `matches up to ${JSON.stringify(diagnosis.matched)} and ` +
                  "diverges after that."),
      });
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
        `moved). Update it to ${document.contentHash}.`,
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
  labellers: {
    labeller: string;
    /** Sections this labeller has decided about — `expect` is a list. */
    labelled: number;
    /** Sections still carrying `UNREAD`. Coverage starts at zero, not full. */
    unread: number;
  }[];
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
        // Entries, not decisions, is what this used to count — so a freshly
        // generated skeleton read as 100% covered and coverage *fell* as the
        // labeller worked. Both numbers are reported now, and their sum is the
        // entry count the old figure was.
        labelled: labelledSections(set).length,
        unread: unreadSections(set).length,
      })),
  }));
}

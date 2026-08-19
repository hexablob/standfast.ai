import type { AtomKind } from "../labels.js";

/**
 * Why a labeller refused an emitted atom. Counted separately because they have
 * different causes and different fixes (docs/12-evaluation.md).
 *
 * - `unsupported`   — the statement does not follow from the quote. Prompt.
 * - `not-knowledge` — true and quoted, but a passing remark, an example, a
 *                     TODO. Prompt.
 * - `duplicate`     — restates an existing canonical atom. Dedup bands.
 */
export const REJECTIONS = [
  "unsupported",
  "not-knowledge",
  "duplicate",
] as const;
export type Rejection = (typeof REJECTIONS)[number];

export type Verdict =
  | {
      accepted: true;
      /**
       * The expected atom this satisfies, or null when the labeller accepts it
       * as true and useful but wrote nothing corresponding.
       *
       * Null is a real outcome, not a gap: the extractor found something the
       * labeller missed. It counts in precision and it cannot count in recall,
       * because recall is measured against what was written blind.
       */
      matched: string | null;
      /**
       * Right statement, wrong `kind`. Recorded and reported; **not** a
       * precision failure. A wrong kind degrades retrieval filtering, it does
       * not put a false claim into the knowledge base, and folding it in would
       * let a retrieval problem consume the budget of a trust problem.
       */
      miscategorised: boolean;
    }
  | { accepted: false; rejection: Rejection };

export type AdjudicatedAtom = {
  /** The section the extractor was working on. */
  sectionHash: string;
  statement: string;
  kind: AtomKind;
  quote: string;
  verdict: Verdict;
};

export type ExtractionScore = {
  emitted: number;
  accepted: number;
  /** accepted / emitted. Null when nothing was emitted — not 1, and not 0. */
  precision: number | null;
  rejections: Record<Rejection, number>;
  miscategorised: { count: number; rate: number | null };
  /**
   * Measured and reported, never the bar. A missed atom leaves the user where
   * they started; a wrong atom gets ratified by a tired human and is then
   * injected into every future session as a directive.
   */
  recall: { expected: number; matched: number; rate: number | null };
  /**
   * `unsupported` is a gate, not a score. If the extractor emitted a statement
   * its own quote does not support, phase 1's exit criterion 1 is false and no
   * precision figure is worth reading.
   */
  gate: { unsupported: number; passed: boolean };
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Scores one slice of adjudicated atoms against the expected atoms of the
 * sections that were processed.
 *
 * `expectedIds` is the denominator of recall and nothing else. It must list
 * every expected atom from every processed section — including the sections the
 * extractor emitted nothing for, which is exactly where recall is lost.
 */
export function scoreExtraction(
  atoms: readonly AdjudicatedAtom[],
  expectedIds: readonly string[],
): ExtractionScore {
  const expected = new Set(expectedIds);
  const matched = new Set<string>();
  const rejections: Record<Rejection, number> = {
    unsupported: 0,
    "not-knowledge": 0,
    duplicate: 0,
  };
  let accepted = 0;
  let miscategorised = 0;

  for (const atom of atoms) {
    if (!atom.verdict.accepted) {
      rejections[atom.verdict.rejection] += 1;
      continue;
    }

    accepted += 1;
    if (atom.verdict.miscategorised) {
      miscategorised += 1;
    }

    const id = atom.verdict.matched;
    if (id === null) {
      continue;
    }
    // An adjudication naming an expected atom that does not exist is a broken
    // input, not a low score. Silently ignoring it would inflate precision and
    // deflate recall at the same time, which is the hardest kind of wrong
    // number to notice.
    if (!expected.has(id)) {
      throw new Error(
        `adjudication matches '${id}', which is not an expected atom of any processed section`,
      );
    }
    matched.add(id);
  }

  return {
    emitted: atoms.length,
    accepted,
    precision: ratio(accepted, atoms.length),
    rejections,
    miscategorised: {
      count: miscategorised,
      rate: ratio(miscategorised, accepted),
    },
    recall: {
      expected: expected.size,
      matched: matched.size,
      rate: ratio(matched.size, expected.size),
    },
    gate: {
      unsupported: rejections.unsupported,
      passed: rejections.unsupported === 0,
    },
  };
}

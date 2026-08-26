import { expectations, type LabelSet } from "./labels.js";

/**
 * What two labellers agreed on, over the sections both of them labelled.
 *
 * A precision number with no agreement number beside it is a statement about
 * one person's taste. This is the number that goes beside it.
 *
 * It is a **lower bound**, and deliberately mechanical. Claim-level agreement —
 * "these two differently-worded statements say the same thing" — needs a human
 * adjudicator, and the one thing that must never do that job is a model of the
 * same family as the extractor.
 */
export type Agreement = {
  pair: [string, string];
  document: string;
  /**
   * Sections **both labellers decided about**.
   *
   * Listing a section is not deciding about it: a skeleton lists every section
   * of the document before anyone has read one. Two untouched skeletons for the
   * same document share every section and agree on all of them, which would
   * report perfect agreement over a corpus nobody has touched. Only a section
   * both sides have taken out of `UNREAD` counts here.
   */
  overlap: number;
  /**
   * Sections both files list where at least one side is still unread. Reported
   * so that a small overlap reads as "not labelled yet" rather than as
   * disagreement.
   */
  unread: number;
  /** Both said the section yields atoms, or both said it yields none. */
  emptiness: { agreed: number; of: number };
  /** Both wrote the same number of expected atoms. */
  count: { agreed: number; of: number };
  /** Jaccard over the exact quote strings, across the overlapping sections. */
  quoteJaccard: number | null;
};

function jaccard(a: Set<string>, b: Set<string>): number | null {
  if (a.size === 0 && b.size === 0) {
    return null;
  }
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

export function agreementBetween(
  left: LabelSet,
  right: LabelSet,
): Agreement | null {
  if (left.document !== right.document) {
    return null;
  }

  const byHash = new Map(right.sections.map((s) => [s.sectionHash, s]));
  const leftQuotes = new Set<string>();
  const rightQuotes = new Set<string>();
  let overlap = 0;
  let unread = 0;
  let emptinessAgreed = 0;
  let countAgreed = 0;

  for (const section of left.sections) {
    const other = byHash.get(section.sectionHash);
    if (!other) {
      continue;
    }
    const mine = expectations(section);
    const theirs = expectations(other);
    if (mine === null || theirs === null) {
      // One of them has not read this section. There is no opinion to agree
      // with, and counting it would let untouched skeletons agree perfectly.
      unread += 1;
      continue;
    }
    overlap += 1;
    if ((mine.length === 0) === (theirs.length === 0)) {
      emptinessAgreed += 1;
    }
    if (mine.length === theirs.length) {
      countAgreed += 1;
    }
    for (const atom of mine) {
      leftQuotes.add(atom.quote);
    }
    for (const atom of theirs) {
      rightQuotes.add(atom.quote);
    }
  }

  if (overlap === 0) {
    return null;
  }

  return {
    pair: [left.labeller, right.labeller],
    document: left.document,
    overlap,
    unread,
    emptiness: { agreed: emptinessAgreed, of: overlap },
    count: { agreed: countAgreed, of: overlap },
    quoteJaccard: jaccard(leftQuotes, rightQuotes),
  };
}

/** Every distinct labeller pair that shares a document. */
export function agreements(labels: readonly LabelSet[]): Agreement[] {
  const found: Agreement[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const left = labels[i];
      const right = labels[j];
      if (!left || !right || left.labeller === right.labeller) {
        continue;
      }
      const agreement = agreementBetween(left, right);
      if (agreement) {
        found.push(agreement);
      }
    }
  }
  return found;
}

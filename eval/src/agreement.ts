import type { LabelSet } from "./labels.js";

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
  /** Sections both labellers wrote an entry for. */
  overlap: number;
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
  let emptinessAgreed = 0;
  let countAgreed = 0;

  for (const section of left.sections) {
    const other = byHash.get(section.sectionHash);
    if (!other) {
      continue;
    }
    overlap += 1;
    if ((section.expect.length === 0) === (other.expect.length === 0)) {
      emptinessAgreed += 1;
    }
    if (section.expect.length === other.expect.length) {
      countAgreed += 1;
    }
    for (const atom of section.expect) {
      leftQuotes.add(atom.quote);
    }
    for (const atom of other.expect) {
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

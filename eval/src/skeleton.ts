import type { LoadedDocument } from "./corpus.js";
import { type LabelSet, UNREAD } from "./labels.js";

/**
 * A blank label set for one document and one labeller.
 *
 * Every section is listed with `expect: "unread"`, which asserts nothing. The
 * labeller replaces that marker with a list of expected atoms, or with `[]` to
 * say "this section states no decision, convention or constraint" — a real
 * label, and the one precision is measured against.
 *
 * The marker is what makes the distinction structural. Listing every section
 * with an empty `expect` would make a freshly generated file a document-wide
 * assertion that nothing in it states anything: full coverage before any work,
 * falling as the labeller deleted the entries they never reached, and perfect
 * agreement between two people who had each done nothing. Silence now has a
 * spelling of its own, and it cannot be reached by inaction.
 *
 * The section *bodies* are deliberately not copied in. They are two files away
 * in `eval/corpus/`, the heading path says which one, and duplicating them here
 * would put the same prose in two places that can disagree.
 */
export function labelSkeleton(
  document: LoadedDocument,
  labeller: string,
  labelledOn: string,
): LabelSet {
  return {
    version: 1,
    document: document.id,
    documentHash: document.contentHash,
    labeller,
    labelledOn,
    blind: true,
    modelAssisted: false,
    sections: document.sections.map((section) => ({
      ordinal: section.ordinal,
      headingPath: section.headingPath,
      sectionHash: section.sectionHash,
      expect: UNREAD,
    })),
  };
}

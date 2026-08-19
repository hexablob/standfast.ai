import type { LoadedDocument } from "./corpus.js";
import type { LabelSet } from "./labels.js";

/**
 * A blank label set for one document and one labeller.
 *
 * Every section is listed with an empty `expect`, and the labeller either fills
 * it in or leaves it empty to mean "this section states nothing". Sections they
 * have not reached yet are deleted from the file — absence is what "unlabelled"
 * means, and the coverage report reads it that way.
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
      expect: [],
    })),
  };
}

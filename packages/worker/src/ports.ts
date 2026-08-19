import type { EgressEntry } from "@standfast/core";
import type { schema } from "@standfast/db";

/** The three atom kinds, ordered by force in docs/04-data-model.md. */
export type AtomKind = (typeof schema.atomKind.enumValues)[number];

/**
 * The three things extraction cannot do for itself.
 *
 * Ports rather than direct calls, so phase 1c can build and test the whole
 * pipeline with no network and no secrets, and phase 1d becomes the act of
 * writing three adapters. Every one carries a readonly `id` that feeds
 * `extractorVersion` — the id is identity, never dispatch, and nothing branches
 * on it.
 */

/** One section's worth of input. Never a document: extraction is per section. */
export type SectionInput = {
  readonly headingPath: readonly string[];
  readonly body: string;
};

/**
 * A statement the extractor claims the section makes, and the words it claims
 * to have read it in.
 *
 * Nothing has checked the quote at this point. That is the next stage's job,
 * and it is where most candidates die.
 */
export type Candidate = {
  readonly quote: string;
  readonly statement: string;
  readonly kind: AtomKind;
};

export interface Extractor {
  /** Names the model and prompt pair. Feeds the extractor version. */
  readonly id: string;

  /**
   * What leaves the machine when this port is called, or null when nothing does.
   *
   * Required, not optional, so every implementation has to answer the question.
   * A deterministic fake says null and means it; an adapter says the allowlist
   * entry it was constructed against, which is the same object it asserted
   * itself against — so the entry cannot describe one destination while the
   * socket opens on another. The handler writes one `egress_events` row per call
   * on any port that returns non-null, and none for the ones that return null,
   * which is why "the CI run discloses nothing" is a fact about the type rather
   * than a claim about the configuration.
   */
  readonly egress: EgressEntry | null;

  /**
   * The largest input this extractor accepts, in characters.
   *
   * Declared rather than assumed, because the window a long section is split
   * into has to be smaller than the smaller of this and the embedder's limit —
   * and a port that does not state its limit cannot constrain a window.
   */
  readonly maxInputChars: number;

  /**
   * Candidates in the order they occur in the section.
   *
   * The order is part of the extractor version, not an implementation detail:
   * dedup is first-writer-wins, so an implementation that reorders produces a
   * different and equally correct set of atoms. That is fine for a running
   * system and noise to the evaluation harness.
   *
   * Windowing a long section happens in here and never reaches storage.
   */
  extract(
    section: SectionInput,
    signal: AbortSignal,
  ): Promise<readonly Candidate[]>;
}

export interface Embedder {
  readonly id: string;
  readonly maxInputChars: number;
  readonly egress: EgressEntry | null;

  /**
   * One vector per input, in the same order, each exactly
   * {@link EMBEDDING_DIMENSIONS} long.
   *
   * Batched, because both candidate providers batch and a one-at-a-time port
   * would make a four-hundred-section document four hundred round trips. That
   * is a shape decision rather than a performance one: changing it later
   * rewrites the pipeline's control flow rather than an adapter.
   */
  embed(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]>;
}

/** Fixed by `atoms.embedding vector(1024)` in migration 0002. */
export const EMBEDDING_DIMENSIONS = 1024;

export type Verdict = "same-claim" | "different-claim";

export interface DedupJudge {
  readonly id: string;
  readonly egress: EgressEntry | null;

  /**
   * Asked only for pairs inside the intermediate band.
   *
   * Asymmetric by construction: there is no return value that reaches the
   * incumbent. `same-claim` suppresses the *candidate*, and the judge has no
   * write path to anything that already exists — it cannot modify, demote or
   * delete an atom.
   *
   * An implementation is prompted to falsify: name a situation in which these
   * two statements would rule differently. Asking for support finds support.
   */
  adjudicate(
    pair: { readonly candidate: string; readonly incumbent: string },
    signal: AbortSignal,
  ): Promise<Verdict>;
}

export type Ports = {
  readonly extractor: Extractor;
  readonly embedder: Embedder;
  readonly judge: DedupJudge;
};

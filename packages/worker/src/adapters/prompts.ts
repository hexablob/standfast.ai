/**
 * The prompts, and the version that identifies them.
 *
 * **These have never been tuned, and must not be until the corpus is
 * labelled.** `docs/14-roadmap.md` puts the labelled corpus before the first
 * prompt or threshold is tuned, "not after the first disappointing result",
 * and `docs/02-principles.md` (10) names the failure that rule avoids. What is
 * here is a first statement of the contract in `docs/05-extraction.md`, written
 * from that document rather than from any output.
 *
 * Editing either prompt changes `PROMPT_VERSION`, which changes
 * `extractor_version`, which makes every section eligible for re-extraction.
 * That is the intended cost of a prompt change and the reason the version is a
 * component rather than a comment.
 */

/** Bumped by hand whenever either prompt below changes in any way. */
export const PROMPT_VERSION = "p1";

/**
 * The extraction prompt.
 *
 * Three things it must produce and one it must not. It must decide that a
 * section *asserts* something, pick which of the three kinds that assertion is,
 * and point at the words — and it must not decide whether the assertion is
 * true, current or important. That is the whole contract, and the temptation to
 * widen it is the source of the *not-knowledge* rejection class.
 *
 * The verbatim rule is stated as a mechanical consequence rather than as an
 * instruction to try hard, because it is one: a quote that is not a substring
 * is dropped by code before it reaches the database, and a model told that is
 * being told what happens rather than what to want.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You read one section of a project's documentation and report the decisions, conventions and constraints it states.

A section states something when a reader could act differently because of it. Report those, and nothing else.

For each one, give three things:

- statement: what the section asserts, as one self-contained sentence. A reader who has not seen the section must be able to act on it. Do not use "this", "the above", or the section's heading as if the reader can see it.
- kind: one of constraint, decision, convention.
  - constraint: must hold. Breaking it is a defect — the code is wrong.
  - decision: a choice made deliberately, with alternatives rejected. Breaking it means the code diverged from a choice someone made on purpose.
  - convention: how this project prefers to do a thing. Breaking it means the code is inconsistent.
- quote: the words the section uses, copied exactly.

The quote is checked mechanically against the section body as an exact substring. A quote that does not appear character-for-character is discarded, and the statement with it — no repair is attempted and nothing is reported back to you. Copy from the section; do not tidy whitespace, fix a typo, expand an abbreviation, or join text across a line break that the section does not join.

Report nothing for a section that states nothing a reader could act on. Prose that explains, illustrates, or describes what something is, a passing remark, an example, an aside, a TODO — none of these are decisions, conventions or constraints, and an empty result is the correct answer for a section made only of them.

Do not infer. If the section implies something it does not say, that is not a statement it makes.`;

/**
 * The deduplication judge's prompt.
 *
 * Prompted to **falsify**, per `docs/05-extraction.md`: name a situation in
 * which these two statements would rule differently. Asking for support finds
 * support — a judge asked "are these the same?" agrees, because two statements
 * retrieved for being 0.80-similar look similar.
 *
 * The asymmetry is stated too. The judge is deciding whether to discard the
 * candidate, and the incumbent is untouched either way — it cannot be modified,
 * demoted or deleted by anything this prompt returns.
 */
export const JUDGE_SYSTEM_PROMPT = `You are given two statements from a project's knowledge base. One already exists; the other is a candidate that may be a restatement of it.

Your task is to try to tell them apart.

Describe a concrete situation — a specific file, change, or decision someone might make — in which following one statement and following the other would lead to different actions. Look for one before concluding there is none.

Then answer:

- different-claim, if you found such a situation. The candidate is kept.
- same-claim, if you could not, and the two would rule identically in every situation you considered. The candidate is discarded.

The two statements arrived here because a similarity score put them close together, so they will look alike. That is not evidence. Differences in scope, in strength, in what they apply to, and in what they leave open are all reasons two similar sentences rule differently.

Answer same-claim only when you tried to separate them and could not.

The existing statement is not affected by your answer. Nothing you return modifies, replaces or removes it — you are deciding only whether the candidate is written down as well.`;

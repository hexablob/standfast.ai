import { describe, expect, it } from "vitest";
import { RECONCILE_PROMPT, RECONCILE_PROMPT_VERSION } from "./prompt.js";

/**
 * The guard on the prompt's shape.
 *
 * `docs/07-reconciliation.md` notes that the asymmetric evidence rule is a
 * database constraint "rather than in a prompt, because prompts are edited by
 * whoever is iterating on accuracy that week". This file is the other half of
 * that observation. Nothing about a prompt stops someone from softening it: the
 * quickest way to raise agreement between a checker and a reviewer is to ask
 * the model whether the file seems all right, and the quickest way to make a
 * verdict feel less blunt is to let it carry a number. Both edits look like
 * tuning and both convert falsification into confirmation.
 *
 * So the properties are asserted, not documented. What is tested here is only
 * the shape of the question — the accuracy of the answers is the eval harness's
 * job (`docs/12-evaluation.md`), and it cannot be measured at all if the prompt
 * has quietly stopped asking for a counter-example. A confirmation-shaped edit
 * fails here, loudly, before it reaches a corpus.
 */
describe("RECONCILE_PROMPT", () => {
  it("asks for the disproof, and for where it is", () => {
    // docs/02-principles.md (8): ask what would disprove the claim. The line
    // numbers are the artefact that makes the answer checkable by a human.
    expect(RECONCILE_PROMPT).toMatch(/false|counter-example/i);
    expect(RECONCILE_PROMPT).toMatch(/line numbers/i);
  });

  it("never asks for confirmation, a grade, or a hedge", () => {
    // The question whose answer is agreeable-sounding prose.
    expect(RECONCILE_PROMPT).not.toMatch(/does this (file|code) follow/i);
    expect(RECONCILE_PROMPT).not.toMatch(/look(s)? (fine|correct|good)/i);
    // A self-reported number invites a threshold, and a threshold on a
    // self-reported number is self-ratification with arithmetic in front.
    expect(RECONCILE_PROMPT).not.toMatch(/confiden/i);
    expect(RECONCILE_PROMPT).not.toMatch(/\brate\b|\bscore\b/i);
    // Severity belongs to atoms.kind; grading it here lets an agent set the
    // volume of its own alarm.
    expect(RECONCILE_PROMPT).not.toMatch(/severit/i);
    // Every partial verdict is a violation with hedging or an atom that says
    // two things. That pressure belongs on extraction.
    expect(RECONCILE_PROMPT).not.toMatch(/partially/i);
  });

  it("names all four verdicts", () => {
    // Four values is a vocabulary. Dropping one does not simplify the prompt,
    // it forces the missing case into a neighbouring verdict as a lie.
    for (const verdict of [
      "honored",
      "violated",
      "not_applicable",
      "unverifiable",
    ]) {
      expect(RECONCILE_PROMPT).toContain(verdict);
    }
  });

  it("states that no field accepts code", () => {
    // Founding invariant 3, enforced at the wire and stated to the one party
    // that could break it (docs/07-reconciliation.md).
    expect(RECONCILE_PROMPT).toMatch(/no field accepts code/i);
  });

  it("carries a version an eval run can name", () => {
    expect(RECONCILE_PROMPT_VERSION).toBeTypeOf("string");
    expect(RECONCILE_PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});

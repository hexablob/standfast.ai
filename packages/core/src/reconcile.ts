/**
 * The reconciliation vocabulary, and the two validation rules that keep source
 * code off the reconciliation path.
 *
 * `docs/07-reconciliation.md` settles all of this. It lives in core rather than
 * in the schema or the route because three separate things have to agree on it
 * — the Postgres enums, the request schema the API refuses on, and the tests
 * that pin both — and a vocabulary written down three times is a vocabulary
 * that drifts twice.
 *
 * Pure domain: no I/O, no database, no network.
 */

/**
 * What one check of one atom against one file concluded.
 *
 * The order is the order of the `finding_verdict` enum in migration 0009, and
 * the two must stay in step because the enum is built from this array.
 *
 * `honored` is a *residual*, not a proof: it is what gets recorded when the
 * search for a counter-example came back empty. `docs/07-reconciliation.md` is
 * explicit that nothing here proves an atom is honored, which is why nothing
 * downstream renders it as a green tick.
 *
 * There is deliberately no `partially_honored`. A violation that applies to
 * part of a file is a violation, and a vocabulary that offers a hedge gets one.
 */
export const FINDING_VERDICTS = [
  "honored",
  "violated",
  "not_applicable",
  "unverifiable",
] as const;

export type FindingVerdict = (typeof FINDING_VERDICTS)[number];

/**
 * Where a finding sits in the human queue.
 *
 * `recorded` is not a queue state — it is the terminal state of every
 * non-violation. Exactly the violations enter the queue and every violation
 * does, which migration 0009 enforces as a biconditional rather than trusting
 * whoever writes the next insert.
 */
export const FINDING_STATUSES = [
  "recorded",
  "open",
  "accepted",
  "dismissed",
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * Which loop produced a run.
 *
 * **Self-reported by the client, and therefore analytics and never control.**
 * Nothing gates on it, no policy reads it, and it is a claim rather than a
 * fact. It is recorded because tuning the loop without knowing which trigger
 * produces the noise is tuning blind.
 *
 * `stale` ships unemitted: it needs a threshold in time that nobody has
 * measured, and inventing one would be tuning on nothing.
 */
export const RECONCILIATION_TRIGGERS = [
  "post_edit",
  "session_end",
  "explicit",
  "agent",
  "atom_ratified",
  "stale",
] as const;

export type ReconciliationTrigger = (typeof RECONCILIATION_TRIGGERS)[number];

/**
 * The cap on the one free-text field anywhere on the reconciliation path.
 *
 * `docs/07-reconciliation.md` calls the rationale the hole in the third
 * founding invariant: it is the only place an agent could paste source into a
 * system whose whole promise is that source never leaves the machine. Whether
 * a length cap is *sufficient* is still open in `docs/13-threat-model.md`, and
 * removing the field entirely stays on the table. This number is a reduction of
 * the blast radius, not an answer.
 */
export const RATIONALE_MAX_CHARS = 280;

export const FILE_PATH_MAX_CHARS = 1024;

/**
 * Rejects anything that is not a single short line of prose.
 *
 * Two rules, both structural:
 *
 * - **Length.** 280 characters holds a sentence and not a function.
 * - **One line, and visibly one line.** A rationale is one sentence; a pasted
 *   snippet is not, and code stripped of the characters below has already lost
 *   the thing that made it code.
 *
 * "One line" has to mean every character a renderer breaks a line on, not only
 * the ASCII ones. `\n`, `\r` and `\t` are the obvious ones; U+0085 (NEL),
 * U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are line terminators
 * too, and a rule that stopped at the C0 block would have let a snippet through
 * with its newlines swapped for U+2028 while still claiming, in this comment,
 * to accept one line.
 *
 * The invisible and direction-changing characters go with them, for a different
 * reason. The entire purpose of this field is that a human reads it and decides
 * whether a violation is real. A right-to-left override or a zero-width joiner
 * makes rendered text differ from submitted text — the Trojan Source trick —
 * and a decision field where those two disagree is worse than no field at all.
 * Nothing legitimate needs them in one sentence about a line of code.
 *
 * Deliberately *not* a list of suspicious patterns. `docs/13-threat-model.md`
 * refuses a corpus of banned phrases — it would be bypassable by anyone who
 * read it and would fail honest prose that happened to match. These rules match
 * no phrases and can be stated in full to an attacker without weakening them.
 *
 * None of this closes the question the threat model keeps open against this
 * field — whether a cap and a shape are sufficient at all, or whether free text
 * has no place on this path. It only makes the rule true as written.
 */
export function isSubmittableRationale(rationale: string): boolean {
  if (rationale.length > RATIONALE_MAX_CHARS) return false;
  if (rationale.trim().length === 0) return false;
  return !hasHiddenOrBreakingCharacter(rationale);
}

/**
 * C0 and DEL, C1 (which carries U+0085 NEL), the two Unicode line terminators,
 * and the zero-width and bidirectional format characters.
 *
 * One home, because two fields depend on it and they must not drift: the
 * rationale, which is never served back, and the file path, which always is.
 */
function hasHiddenOrBreakingCharacter(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the rule.
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(
    value,
  );
}

/**
 * A backstop on the path a finding points at — not validation.
 *
 * The server holds no file tree and never will, so it cannot check that a path
 * exists, and `docs/07-reconciliation.md` says so plainly. What it can refuse
 * is a path that is not shaped like a path.
 *
 * Two of the three rules are about traversal — absolute, or climbing out
 * through `..`. Neither has any meaning in a finding, and both are what an
 * escape attempt looks like if one of these strings is ever joined to a real
 * root.
 *
 * **The third rule is the one that matters most, and it was missing.** This
 * field is 1024 characters long and, unlike the rationale, it is *served back
 * out* — it is the pointer the human clicks, so it appears in every findings
 * response and in the CLI. Without a character rule an agent could put a
 * newline and forty lines of source into it and have the server store and echo
 * them: a second free-text field, larger than the one the threat model
 * recognises as the hole, and with none of its controls. A path does not
 * contain a line break, a tab, or an invisible direction override, so the same
 * character rule the rationale uses applies here — for the same reason, and
 * with more at stake because this one is read back.
 */
export function isSubmittableFilePath(filePath: string): boolean {
  if (filePath.length === 0 || filePath.length > FILE_PATH_MAX_CHARS) {
    return false;
  }
  if (filePath.startsWith("/")) return false;
  if (/(^|\/)\.\.(\/|$)/.test(filePath)) return false;
  return !hasHiddenOrBreakingCharacter(filePath);
}

/**
 * The queue biconditional, in code, so no caller ever chooses.
 *
 * Exactly the violations enter the human queue and every violation does. The
 * database enforces the same rule as a check constraint; this is what makes the
 * insert satisfy it without a route ever deciding, because a queue that depends
 * on what the writer of the day remembered to set is not a queue.
 */
export function statusForVerdict(
  verdict: FindingVerdict,
): Extract<FindingStatus, "recorded" | "open"> {
  return verdict === "violated" ? "open" : "recorded";
}

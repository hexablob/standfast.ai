/**
 * The instruction an agent is handed before it reconciles a file.
 *
 * `docs/07-reconciliation.md` (*Falsify, don't confirm — operationally*) is the
 * whole of this file, restated as something a model reads. The document's first
 * consequence is that the prompt asks for a counter-example rather than for an
 * assessment: *"find the lines in this file that make X false"*, never *"is X
 * respected here?"*. The second question is answerable with agreeable-sounding
 * prose, and a model asked whether something seems all right will say that it
 * does. The first question has an artefact as its answer, or it has no answer —
 * and "no answer" is exactly the state this system wants to record.
 *
 * The verdict names below are written into the prompt text rather than imported
 * from `packages/core`, and that is a licence boundary rather than an oversight.
 * `packages/core` is AGPL-3.0-only; this package is Apache-2.0 because it ships
 * to a user's machine, and `packages/sdk` exists so the CLI and the MCP server
 * have something to depend on without inheriting copyleft
 * (`docs/03-architecture.md`). Importing core here would quietly relicense the
 * MCP server. `hooks.ts` duplicates a token estimator for the same reason and
 * says so; this is the second instance of the same deliberate trade, written
 * down so the next person does not "fix" it. The server validates the four
 * values anyway, so a drift between this text and the enum is a rejected call,
 * not a silent corruption.
 */

/**
 * Bumped by hand whenever {@link RECONCILE_PROMPT} changes in any way, so that
 * an evaluation run can name the prompt it scored.
 *
 * **There is deliberately no `prompt_version` column on the finding row.**
 * Nothing on the server reads such a value: reconciliation results are not
 * re-derived from a prompt the way extraction results are re-derived from an
 * extractor, so no query would filter on it and no job would key off it. A
 * column nobody reads is permission nobody is using — it is a field an agent is
 * invited to fill with whatever it likes, kept forever, on the chance that it
 * matters later. The version lives here, next to the text it versions, and the
 * eval harness records it alongside the run. That is the only reader there is.
 */
export const RECONCILE_PROMPT_VERSION = "reconcile-1";

/**
 * The falsification instruction, with one `{path}` placeholder.
 *
 * The caller substitutes it — `RECONCILE_PROMPT.replaceAll("{path}", path)` —
 * and appends the retrieved statements underneath. A placeholder rather than a
 * function because there is exactly one substitution and one call site; a
 * builder function would be a wrapper around `replaceAll` with a docstring.
 *
 * **The order of the two questions is fixed and the text says so twice.** The
 * agent is asked for the counter-example first and records `honored` only after
 * that search returns empty. Reversing the order — settle the conclusion, then
 * go looking for exceptions — produces confirmation with extra steps, and it
 * produces it reliably, which is worse than producing it occasionally: a
 * checker that is wrong at random gets noticed.
 *
 * Four things this must never ask for, each of them declined on the record in
 * `docs/07-reconciliation.md` (*Considered and declined in the vocabulary*):
 * a severity, which is a property of the atom's `kind` and would let an agent
 * grade the volume of its own alarm; a confidence number, which is the
 * auto-promotion vector `docs/14-roadmap.md` excludes by name; a hedged middle
 * verdict, which is always either a violation with an apology attached or an
 * atom that says two things; and free-form verdict prose, which is a place for
 * a paragraph where a vocabulary of four belongs. `prompt.test.ts` fails if any
 * of them reappears, because prompts are edited by whoever is chasing accuracy
 * that week.
 */
export const RECONCILE_PROMPT = `You are checking one file against knowledge this project has already ratified.

The file is {path}. Read it. Each statement below was retrieved because something suggests it governs that file.

For every statement, in this order and never the other order:

1. Find the lines in {path} that make the statement FALSE, and quote the line numbers.
2. Record honored only once step 1 has come back empty.

Then give exactly one verdict per statement:

- violated — you found the counter-example. Give the line numbers that contradict the statement. A violated verdict without them is refused: a violation points at its own disproof, or it is not one.
- honored — you searched the lines you read for a counter-example and did not find one. It records coverage, not proof. It is what is left over when a search fails, and it is never an affirmative claim about the file.
- not_applicable — the statement does not govern this file. That is not a miss on your part; it tells the project that the wrong knowledge was selected for this file.
- unverifiable — the statement cannot be decided by reading code at all. "Prefer clarity over cleverness" is a thing documents say and no file answers. Forcing it to honored or violated would be a lie either way; this verdict sends it back to whoever wrote it.

Submit every verdict in a single reconcile call: one call for the whole run, not one call per statement.

No field accepts code. Not a diff, not a snippet, not truncated, not hashed. A verdict, a path and line numbers, and nothing else.`;

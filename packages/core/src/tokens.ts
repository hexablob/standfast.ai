/**
 * A conservative upper bound on how many tokens a string costs.
 *
 * `docs/06-retrieval.md` (*Assembly under a token budget*) requires the
 * assembler to count an upper bound and pack against that, so that overshoot is
 * impossible for any client. There is no single true token count: the pack is
 * consumed by Claude, Cursor, Codex and Gemini, and their tokenizers disagree.
 * A number that is right for one of them is wrong for the other three, and the
 * direction of the error is what matters — under-counting hands a client a pack
 * that does not fit the budget it asked for.
 *
 * **This is a bound, not a measurement**, and the response says so: the
 * `budget_tokens_used` an agent reads is this number, which is why the field is
 * documented as an upper bound rather than a count.
 *
 * ## What it assumes, stated rather than hidden
 *
 * `packages/mcp/src/budget.test.ts` approximates four characters per token for
 * English prose and states the approximation instead of pretending to a
 * precision it does not have. This does the same thing one level more
 * carefully, because a serialised pack is not English prose — it is JSON, and
 * JSON is mostly punctuation.
 *
 * - A run of letters and digits costs `ceil(length / 3)`. Byte-pair tokenizers
 *   average nearer four to six characters per token on English words, so three
 *   leaves margin, and it stays right for the identifier-shaped strings atoms
 *   are full of.
 * - Every other non-whitespace character costs one token each. Braces, quotes,
 *   colons and slashes rarely merge, and a pack serialised to JSON is dense
 *   with them. Counting them at four characters per token — the naive
 *   approximation — under-counts an envelope by a wide margin.
 * - Whitespace costs nothing, because tokenizers attach it to the token that
 *   follows.
 *
 * **Where the bound stops being a bound.** A run of high-entropy alphanumerics
 * — a base64 blob, a hash — can tokenize at one token per character, above the
 * `length / 3` this assumes. Atom statements are prose written by humans and
 * quotes lifted from Markdown, so the case does not arise in the corpus this is
 * gated on; it is named here because a bound whose limits are undocumented gets
 * trusted outside them. If it ever matters at the margin the fix is a real
 * tokenizer, not a bigger divisor.
 */

/**
 * Characters per token assumed inside an alphanumeric run.
 *
 * Not a measurement of any tokenizer. A deliberate under-estimate of how much
 * text a token holds, which is what makes the total an over-estimate.
 */
export const CHARS_PER_ALPHANUMERIC_TOKEN = 3;

const ALPHANUMERIC = /[A-Za-z0-9]/;
const WHITESPACE = /\s/;

/**
 * The upper bound, in tokens, on `text`.
 *
 * Pure and allocation-free over the input: the assembler calls it once per
 * candidate per greedy step, and a pack of a few dozen atoms would otherwise
 * spend more time counting than retrieving.
 */
export function tokenUpperBound(text: string): number {
  let tokens = 0;
  let run = 0;

  for (const character of text) {
    if (ALPHANUMERIC.test(character)) {
      run += 1;
      continue;
    }

    if (run > 0) {
      tokens += Math.ceil(run / CHARS_PER_ALPHANUMERIC_TOKEN);
      run = 0;
    }

    // Whitespace rides along with the next token in every tokenizer we target.
    if (!WHITESPACE.test(character)) tokens += 1;
  }

  if (run > 0) tokens += Math.ceil(run / CHARS_PER_ALPHANUMERIC_TOKEN);

  return tokens;
}

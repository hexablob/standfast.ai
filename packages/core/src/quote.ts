/**
 * Where a quote sits inside a section body.
 *
 * Half-open, `[start, end)`, measured in **Unicode code points** — not UTF-16
 * code units, and not bytes. This is the unit `atoms.source_span` stores and the
 * unit the `standfast_verify_atom_quote` trigger measures in, because Postgres
 * `substring` over `text` counts characters.
 */
export type Span = { readonly start: number; readonly end: number };

/**
 * Finds a quote in a section body and records where it is.
 *
 * Three rules, all of them from docs/05-extraction.md, and each one is a place
 * the obvious implementation is wrong:
 *
 * 1. **No normalisation.** Not trimmed, not whitespace-collapsed, not
 *    unescaped, not case-folded. Every normalisation is a point where the span
 *    stops indexing the body that is actually stored, and the trigger then
 *    rejects a quote that the worker believes it verified.
 * 2. **Absent means dropped.** `null` is returned and the caller discards the
 *    candidate. It is never fuzzy-matched to the nearest passage. This is the
 *    anti-hallucination mechanism, and there is no repair step.
 * 3. **First occurrence wins.** A quote appearing twice is not ambiguous, it is
 *    just short; picking the first is deterministic and picking "the best" is
 *    not.
 *
 * The arithmetic is the subtle part. `String.prototype.indexOf` is correct for
 * *finding* the quote and wrong for *recording* where it is: it counts UTF-16
 * code units, so a single emoji anywhere before the quote shifts every offset
 * by one and the stored span names text that is not the quote. An
 * implementation that returns `at` directly passes every ASCII test and
 * corrupts provenance the first time a document contains one.
 */
export function locateQuote(body: string, quote: string): Span | null {
  const at = body.indexOf(quote);
  if (at < 0) return null;

  const start = [...body.slice(0, at)].length;
  return { start, end: start + [...quote].length };
}

/**
 * The text a span names, or null if the span does not fit the body.
 *
 * The inverse of {@link locateQuote}, and the same comparison the database
 * trigger makes on write. Used to check the two agree — the worker verifies in
 * application code before inserting, because a caught `check_violation` aborts
 * the transaction and the trigger must be a backstop rather than flow control.
 */
export function quoteAt(body: string, span: Span): string | null {
  if (span.start < 0 || span.end < span.start) return null;

  const points = [...body];
  if (span.end > points.length) return null;

  return points.slice(span.start, span.end).join("");
}

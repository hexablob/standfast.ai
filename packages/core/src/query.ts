/**
 * Deterministic query preparation.
 *
 * `docs/06-retrieval.md` (*Trigram — identifiers and paths*): splitting a path
 * into components, splitting `camelCase` and `snake_case`, lowercasing. All of
 * it is string manipulation with no model in it, **which is why it is allowed
 * on the read path at all**. The same document declines model-based query
 * expansion in *Considered and declined*: a model call before the query is
 * still a model call on the read path, and principle 4 governs it.
 *
 * So the line this module draws is the important thing about it. Everything
 * here is reproducible from the input string alone — same query, same
 * expansion, forever, with no version to pin and no latency to bound.
 */

/**
 * Splits an identifier or path into the words hiding inside it.
 *
 * `packages/db/src/schema/rls.ts` becomes `packages db src schema rls`, and
 * `withActor` becomes `with actor`. The original is always kept alongside its
 * parts, so a caller can tell an exact naming from a discussion of the parts.
 *
 * **Nothing on the read path calls this today.** It fed {@link lexicalQuery}
 * until measuring showed that adding terms to a conjunctive query adds
 * obligations rather than alternatives — see that function. It is kept because
 * the split itself is correct and tested, and because the disjunctive form of
 * the lexical query is one of the two options `docs/12-evaluation.md`'s corpus
 * has to choose between; under `or` semantics this is exactly what it would
 * expand. Deleting it would mean rewriting and re-testing it to answer that
 * question.
 */
export function splitIdentifiers(text: string): string[] {
  const out: string[] = [];

  for (const token of text.split(/\s+/).filter(Boolean)) {
    out.push(token);

    const parts = token
      // Path and namespace separators.
      .split(/[/\\.:#]+/)
      // snake_case, kebab-case.
      .flatMap((part) => part.split(/[_-]+/))
      // camelCase and PascalCase, including the `HTTPServer` boundary — a run
      // of capitals followed by a capitalised word splits before the last one,
      // not after the first, or `HTTPServer` becomes `h t t p server`.
      .flatMap((part) =>
        part
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .split(/\s+/),
      )
      .filter((part) => part.length > 0);

    // Only worth adding when the split actually found something. A plain word
    // splits to itself, and pushing it twice would double its lexical weight
    // for no reason anyone chose.
    if (parts.length > 1) out.push(...parts);
  }

  return out;
}

/**
 * What generator 2 searches for: the words the developer typed, and no others.
 *
 * **This deliberately does not expand identifiers, and that is a correction.**
 * It did, on the reasoning that a `tsvector` sees `packages`, `core` and loses
 * that they were one string — true — so feeding both the whole token and its
 * parts would let either match. That reasoning ignored the parser.
 *
 * `websearch_to_tsquery` builds a **conjunction**: unquoted words are ANDed.
 * Measured against a real Postgres, `packages/db` alone becomes
 * `'packages/db'` — one required lexeme — while the expanded form
 * `packages/db packages db` becomes `'packages/db' & 'packag' & 'db'`, three.
 * Adding alternatives to a conjunctive query does not offer the engine a
 * choice; it adds obligations. An atom reading "the db package is pure domain"
 * matched the first and fails the second. The expansion made the generator
 * strictly worse at the thing it was added to improve, and nothing failed —
 * the generator simply returned less, which fusion absorbs silently.
 *
 * Paths and identifiers are generator 3's job, which is why generator 3 exists
 * and why it keeps the string whole. {@link splitIdentifiers} stays exported
 * because that division of labour is the design, not because this function
 * needs it.
 *
 * **What is still open, and is a tuning question rather than a defect.** A
 * conjunction over a whole task description — six or ten words, all
 * required — will match very little, and `scope: "task"` is the shape that
 * produces exactly that. `websearch_to_tsquery` can express disjunction with
 * its `or` keyword but has no grouping, so the choice is all-AND or all-OR and
 * not the `(word | its parts) & (word | its parts)` one would actually want.
 * Which of the two ranks better is a question for `docs/12-evaluation.md`'s
 * corpus; `docs/02-principles.md` (10) forbids picking one before it exists,
 * so this stays as the design document specifies and the question is recorded
 * rather than quietly answered.
 */
export function lexicalQuery(text: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const token of text.split(/\s+/).filter(Boolean)) {
    const lowered = token.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    parts.push(lowered);
  }

  return parts.join(" ");
}

/**
 * What generator 3 matches on.
 *
 * Lowercased and whitespace-collapsed, and otherwise **untouched** — the
 * separators stay. Trigrams exist to match `schema/rls` against
 * `packages/db/src/schema`, and splitting the string first would throw away the
 * substring the match is made of. This is the one place the path is wanted
 * whole.
 */
export function trigramQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The paths a `scope: "file"` request named, prepared for matching as text.
 *
 * **The honest limit, restated at the call site.** There is no table joining a
 * source file to the atoms that govern it, because there is no representation
 * of source code — that exclusion is invariant 3 and is not negotiable. So a
 * path is matched against statements and quotes that happen to name it, which
 * project documents do constantly. `docs/06-retrieval.md` records that this
 * works better than it sounds and worse than a real index, and that phase 3
 * improves it with observed `file_path` → `atom_id` associations rather than
 * with an index anyone built.
 */
export function pathQuery(paths: readonly string[]): string {
  return trigramQuery(paths.join(" "));
}

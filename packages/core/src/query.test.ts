import { describe, expect, it } from "vitest";
import {
  lexicalQuery,
  pathQuery,
  splitIdentifiers,
  trigramQuery,
} from "./query.js";

/**
 * The property that matters most is not any particular split. It is that every
 * function here is a pure function of its input — `docs/06-retrieval.md`
 * declines model-based query expansion, and what makes deterministic expansion
 * admissible on the read path is exactly that it has no version to pin and no
 * latency to bound.
 */
describe("splitIdentifiers", () => {
  it("splits a path into its components and keeps the whole", () => {
    expect(splitIdentifiers("packages/db/src/schema/rls.ts")).toEqual([
      "packages/db/src/schema/rls.ts",
      "packages",
      "db",
      "src",
      "schema",
      "rls",
      "ts",
    ]);
  });

  it("splits camelCase", () => {
    expect(splitIdentifiers("withActor")).toEqual([
      "withActor",
      "with",
      "Actor",
    ]);
  });

  it("splits snake_case and SCREAMING_SNAKE", () => {
    expect(splitIdentifiers("STANDFAST_ORG_ID")).toEqual([
      "STANDFAST_ORG_ID",
      "STANDFAST",
      "ORG",
      "ID",
    ]);
  });

  /**
   * `HTTPServer` splits before the last capital, not after the first. Getting
   * this backwards turns an acronym into single letters, and a lexical index
   * full of `h`, `t`, `t`, `p` matches everything and means nothing.
   */
  it("splits an acronym followed by a word at the right boundary", () => {
    expect(splitIdentifiers("HTTPServer")).toEqual([
      "HTTPServer",
      "HTTP",
      "Server",
    ]);
  });

  /**
   * A plain word splits to itself, and pushing it twice would silently double
   * its weight in the lexical query for a reason nobody chose.
   */
  it("does not repeat a word that has nothing to split", () => {
    expect(splitIdentifiers("convention")).toEqual(["convention"]);
  });

  it("is a pure function of its input", () => {
    const query = "packages/core is pure domain";
    expect(splitIdentifiers(query)).toEqual(splitIdentifiers(query));
  });
});

describe("lexicalQuery", () => {
  it("lowercases and deduplicates", () => {
    expect(lexicalQuery("Actor actor withActor")).toBe("actor withactor");
  });

  /**
   * It used to expand, and the expansion was measured to be harmful:
   * `websearch_to_tsquery` ANDs, so `packages/db packages db` requires three
   * lexemes where `packages/db` required one. Pinned here so the expansion
   * cannot come back without someone reading why it went.
   */
  it("leaves identifiers whole, because the parser is conjunctive", () => {
    expect(lexicalQuery("packages/db")).toBe("packages/db");
  });

  it("survives text written for no query language at all", () => {
    // `websearch_to_tsquery` never raises, which is why it is the parser
    // chosen; nothing here needs escaping before it gets there.
    expect(() =>
      lexicalQuery('add a "flag" & -remove the (old) one!'),
    ).not.toThrow();
  });
});

describe("trigramQuery", () => {
  /**
   * The one place a path is wanted whole. Trigrams exist to match `schema/rls`
   * against `packages/db/src/schema`, and splitting first throws away the
   * substring the match is made of.
   */
  it("keeps separators, because the substring is the match", () => {
    expect(trigramQuery("packages/db/src/schema")).toBe(
      "packages/db/src/schema",
    );
  });

  it("lowercases and collapses whitespace", () => {
    expect(trigramQuery("  Packages/DB   src  ")).toBe("packages/db src");
  });
});

describe("pathQuery", () => {
  it("joins the paths a file-scoped request named", () => {
    expect(pathQuery(["packages/Core/src/pack.ts", "eval/README.md"])).toBe(
      "packages/core/src/pack.ts eval/readme.md",
    );
  });

  it("is empty for no paths, so the generator simply does not run", () => {
    expect(pathQuery([])).toBe("");
  });
});

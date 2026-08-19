import { describe, expect, it } from "vitest";
import { sectionHash } from "./hash.js";
import { sectionMarkdown } from "./markdown.js";

describe("sectionMarkdown", () => {
  it("splits at ATX headings and nests the heading path", () => {
    const sections = sectionMarkdown(
      ["# Title", "intro", "", "## One", "a", "", "## Two", "b"].join("\n"),
    );

    expect(sections.map((s) => s.headingPath)).toEqual([
      ["Title"],
      ["Title", "One"],
      ["Title", "Two"],
    ]);
    expect(sections.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });

  it("pops the heading stack when a level closes", () => {
    const sections = sectionMarkdown(
      ["# A", "", "## B", "", "### C", "", "## D", ""].join("\n"),
    );
    expect(sections.at(-1)?.headingPath).toEqual(["A", "D"]);
  });

  it("keeps a preamble as a section with no heading path", () => {
    const sections = sectionMarkdown(
      ["front matter", "", "# A", "x"].join("\n"),
    );
    expect(sections[0]?.headingPath).toEqual([]);
    expect(sections[0]?.body).toContain("front matter");
  });

  it("drops a blank preamble", () => {
    const sections = sectionMarkdown(["", "  ", "# A", "x"].join("\n"));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.headingPath).toEqual(["A"]);
  });

  // A document about Markdown would otherwise be shredded by its own examples.
  it("ignores headings inside fenced code blocks", () => {
    const sections = sectionMarkdown(
      ["# Real", "", "```", "# Not a heading", "```", "", "text"].join("\n"),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.headingPath).toEqual(["Real"]);
  });

  it("handles tilde fences", () => {
    const sections = sectionMarkdown(
      ["# Real", "~~~", "# Nope", "~~~"].join("\n"),
    );
    expect(sections).toHaveLength(1);
  });

  it("strips closing hashes from a heading title", () => {
    const sections = sectionMarkdown("### Middle ###\nbody");
    expect(sections[0]?.headingPath).toEqual(["Middle"]);
  });

  describe("offsets", () => {
    it("are code points, not UTF-16 code units", () => {
      // The emoji is one code point and two UTF-16 units. Counting units here
      // would shift every later span by one, and phase 1 quote verification
      // uses Postgres substring, which counts characters.
      const body = ["# A", "🌍", "", "# B", "tail"].join("\n");
      const sections = sectionMarkdown(body);
      const b = sections.find((s) => s.headingPath[0] === "B");
      expect(b).toBeDefined();

      const utf16Index = body.indexOf("# B");
      const codePointIndex = [...body.slice(0, utf16Index)].length;

      // The emoji is one code point and two UTF-16 units, so the two indices
      // differ by exactly one. The offset must be the code point one, because
      // Postgres substring counts characters.
      expect(codePointIndex).toBe(utf16Index - 1);
      expect(b?.start).toBe(codePointIndex);

      // And slicing by code points recovers the section exactly.
      expect([...body].slice(b?.start, b?.end).join("")).toBe(b?.body);
    });

    it("spans cover the document contiguously", () => {
      const body = ["# A", "one", "# B", "two"].join("\n");
      const sections = sectionMarkdown(body);
      expect(sections[0]?.start).toBe(0);
      expect(sections[0]?.end).toBe(sections[1]?.start);
      expect(sections.at(-1)?.end).toBe([...body].length);
    });
  });

  describe("section hashes", () => {
    it("survive the section moving without changing", () => {
      const before = sectionMarkdown(["# A", "aaa", "# B", "bbb"].join("\n"));
      const after = sectionMarkdown(["# B", "bbb", "# A", "aaa"].join("\n"));

      const aBefore = before.find((s) => s.headingPath[0] === "A");
      const aAfter = after.find((s) => s.headingPath[0] === "A");
      expect(aAfter?.sectionHash).toBe(aBefore?.sectionHash);
      expect(aAfter?.ordinal).not.toBe(aBefore?.ordinal);
    });

    it("change when the body changes", () => {
      const a = sectionMarkdown("# A\nbody")[0]?.sectionHash;
      const b = sectionMarkdown("# A\nbody!")[0]?.sectionHash;
      expect(a).not.toBe(b);
    });

    it("change when the heading path changes", () => {
      const a = sectionMarkdown("# A\n\n## X\nbody").at(-1)?.sectionHash;
      const b = sectionMarkdown("# B\n\n## X\nbody").at(-1)?.sectionHash;
      expect(a).not.toBe(b);
    });
  });
});

describe("sectionHash", () => {
  // With any separator a heading could contain, these two would collide and
  // one section would silently inherit the other's identity — suppressing
  // re-extraction of a section that did change.
  it("does not collide across heading-path boundaries", () => {
    expect(sectionHash(["a", "b/c"], "x")).not.toBe(
      sectionHash(["a/b", "c"], "x"),
    );
    expect(sectionHash(["a", "b"], "x")).not.toBe(sectionHash(["ab"], "x"));
  });
});

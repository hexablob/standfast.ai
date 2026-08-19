import { sectionHash } from "./hash.js";

export type Section = {
  ordinal: number;
  headingPath: string[];
  body: string;
  /** Inclusive start offset, in Unicode code points. */
  start: number;
  /** Exclusive end offset, in Unicode code points. */
  end: number;
  sectionHash: string;
};

type Line = {
  text: string;
  /** Code point offset of the first character of the line. */
  start: number;
  /** Code point offset just past the line's newline, or past the end. */
  end: number;
};

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;

/**
 * Splits into lines while tracking offsets in **Unicode code points**, not
 * UTF-16 code units.
 *
 * `atoms.source_span` is an `int4range` that phase 1 will use to verify a
 * verbatim quote with Postgres `substring`, and `substring` counts characters.
 * JavaScript string indices count UTF-16 units, so a single emoji or CJK
 * extension character earlier in the document would shift every later span by
 * one and break verification for exactly the documents nobody tests with.
 */
function splitLines(body: string): Line[] {
  const lines: Line[] = [];
  let utf16LineStart = 0;
  let cpLineStart = 0;
  let cp = 0;
  let i = 0;

  while (i < body.length) {
    if (body[i] === "\n") {
      lines.push({
        text: body.slice(utf16LineStart, i),
        start: cpLineStart,
        end: cp + 1,
      });
      i += 1;
      cp += 1;
      utf16LineStart = i;
      cpLineStart = cp;
      continue;
    }
    const code = body.codePointAt(i);
    i += code !== undefined && code > 0xffff ? 2 : 1;
    cp += 1;
  }

  if (utf16LineStart < body.length || lines.length === 0) {
    lines.push({
      text: body.slice(utf16LineStart),
      start: cpLineStart,
      end: cp,
    });
  }

  return lines;
}

function stripCarriageReturn(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * Splits a Markdown document into sections at ATX headings.
 *
 * Content before the first heading becomes a section with an empty heading
 * path, unless it is blank — a preamble is content, and dropping it would
 * make an atom citing it uncitable.
 *
 * Headings inside fenced code blocks are not headings. A fenced block in a
 * document about Markdown would otherwise shred it.
 */
export function sectionMarkdown(body: string): Section[] {
  const lines = splitLines(body);
  const sections: Section[] = [];

  let openFence: string | undefined;
  const headingStack: { level: number; title: string }[] = [];
  let current: { headingPath: string[]; startLine: number } | undefined = {
    headingPath: [],
    startLine: 0,
  };

  const flush = (endLine: number): void => {
    if (!current) {
      return;
    }
    const first = lines[current.startLine];
    const last = lines[endLine - 1];
    if (!first || !last) {
      return;
    }
    const text = lines
      .slice(current.startLine, endLine)
      .map((l) => stripCarriageReturn(l.text))
      .join("\n");

    // A preamble of nothing but whitespace is not content.
    if (current.headingPath.length === 0 && text.trim() === "") {
      current = undefined;
      return;
    }

    sections.push({
      ordinal: sections.length,
      headingPath: [...current.headingPath],
      body: text,
      start: first.start,
      end: last.end,
      sectionHash: sectionHash(current.headingPath, text),
    });
    current = undefined;
  };

  for (const [index, line] of lines.entries()) {
    const text = stripCarriageReturn(line.text);

    const fence = FENCE.exec(text);
    if (fence?.[1]) {
      if (openFence === undefined) {
        openFence = fence[1][0] === "`" ? "`" : "~";
      } else if (fence[1][0] === openFence) {
        openFence = undefined;
      }
      continue;
    }
    if (openFence !== undefined) {
      continue;
    }

    const heading = ATX_HEADING.exec(text);
    if (!heading?.[1]) {
      continue;
    }

    flush(index);

    const level = heading[1].length;
    const title = (heading[2] ?? "").replace(/[ \t]+#*[ \t]*$/, "").trim();

    while (headingStack.length > 0) {
      const top = headingStack[headingStack.length - 1];
      if (top && top.level >= level) {
        headingStack.pop();
      } else {
        break;
      }
    }
    headingStack.push({ level, title });

    current = {
      headingPath: headingStack.map((h) => h.title),
      startLine: index,
    };
  }

  flush(lines.length);

  return sections;
}

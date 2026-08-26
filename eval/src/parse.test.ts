import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadDirectory, locate } from "./parse.js";

const Item = z.object({
  id: z.string().min(1),
  sections: z.array(
    z.object({ headingPath: z.array(z.string()), kind: z.enum(["a", "b"]) }),
  ),
});

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "standfast-parse-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(name: string, body: unknown): void {
  writeFileSync(
    join(directory, name),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

describe("loadDirectory", () => {
  it("says nothing about a directory that does not exist", () => {
    // A labelling pass nobody has started is not an error, and `check` has to
    // stay quiet about it rather than nagging for a file that is not due yet.
    expect(
      loadDirectory(
        join(directory, "absent"),
        () => true,
        Item,
        (n) => n,
      ),
    ).toEqual({ values: [], problems: [] });
  });

  it("keeps every good file when one is malformed", () => {
    // The defect: one typo used to throw before `check` printed anything, so
    // the corpus listing, coverage and agreement all vanished with it.
    write("good.json", { id: "good", sections: [] });
    write("bad.json", {
      id: "bad",
      sections: [{ headingPath: [], kind: "z" }],
    });

    const loaded = loadDirectory(
      directory,
      () => true,
      Item,
      (n) => n,
    );

    expect(loaded.values.map((v) => v.id)).toEqual(["good"]);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.message).toContain("bad.json");
  });

  it("names the item, not just its array index", () => {
    write("labels.json", {
      id: "x",
      sections: [
        { headingPath: ["Contributing"], kind: "a" },
        { headingPath: ["Contributing", "Setup"], kind: "z" },
      ],
    });

    const loaded = loadDirectory(
      directory,
      () => true,
      Item,
      (n) => n,
    );

    expect(loaded.problems[0]?.message).toContain("Contributing › Setup");
    expect(loaded.problems[0]?.message).toContain("kind");
  });

  it("reports unreadable JSON as a problem, not a crash", () => {
    write("broken.json", "{ not json");

    const loaded = loadDirectory(
      directory,
      () => true,
      Item,
      (n) => n,
    );

    expect(loaded.values).toEqual([]);
    expect(loaded.problems[0]?.message).toContain("not valid JSON");
  });

  it("honours the filter and ignores non-JSON", () => {
    write("keep.json", { id: "keep", sections: [] });
    write("skip.json", { id: "skip", sections: [] });
    write("notes.txt", "ignored");

    const loaded = loadDirectory(
      directory,
      (name) => name.startsWith("keep"),
      Item,
      (n) => n,
    );

    expect(loaded.values.map((v) => v.id)).toEqual(["keep"]);
  });

  it("reports through a union at the branch the writer was aiming at", () => {
    // A union reports its own failure as "Invalid input" at the union's path
    // and hides the reason a branch deeper; that would make every typo inside a
    // labelled section read as `expect — Invalid input`.
    const Unioned = z.object({
      expect: z.union([
        z.literal("unread"),
        z.array(z.object({ k: z.enum(["a"]) })),
      ]),
    });
    write("u.json", { expect: [{ k: "wrong" }] });

    const loaded = loadDirectory(
      directory,
      () => true,
      Unioned,
      (n) => n,
    );

    expect(loaded.problems[0]?.message).toContain("expect[0].k");
    // Not the union's own bare complaint, which locates nothing.
    expect(loaded.problems[0]?.message).not.toMatch(/expect — Invalid input$/);
  });
});

describe("locate", () => {
  it("splices the identifying field of an array item into the path", () => {
    const raw = { sections: [{ headingPath: ["A", "B"], expect: [] }] };

    expect(locate(raw, ["sections", 0, "expect", 0, "quote"])).toBe(
      "sections[0] 'A › B' → expect[0].quote",
    );
  });

  it("names a preamble section rather than leaving it blank", () => {
    const raw = { sections: [{ headingPath: [] }] };

    expect(locate(raw, ["sections", 0])).toContain("(preamble)");
  });

  it("says so when the issue is the whole file", () => {
    expect(locate({}, [])).toBe("(whole file)");
  });
});

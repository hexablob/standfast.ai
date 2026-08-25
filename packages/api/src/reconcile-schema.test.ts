import { RATIONALE_MAX_CHARS } from "@standfast/core";
import { describe, expect, it } from "vitest";
import {
  FindingSchema,
  ReconcileItemSchema,
  ReconcileRequestSchema,
  ResolveFindingSchema,
} from "./schemas.js";

/**
 * **Phase 3, exit criterion 2** (`docs/14-roadmap.md`): no field of `reconcile`
 * accepts source code.
 *
 * A unit test with no database, because the claim is about the shape of the
 * request and not about what any row ends up holding. The wire allowlist's
 * equality test covers the other direction — what a reviewer had to see to add
 * a column — and this covers what a caller is allowed to send.
 *
 * The third founding invariant is that source code never leaves the customer's
 * machine. `reconcile` is the one place in the entire product where an agent
 * that has just *read* source is asked to say something about it, so this is
 * where that invariant is either held or quietly lost.
 */

const valid = {
  atomId: "3f1a5c8e-1b2d-4e6f-8a90-1c2d3e4f5a6b",
  verdict: "honored" as const,
  filePath: "src/auth.ts",
};

describe("the accepted field set", () => {
  it("is exactly a verdict and a pointer", () => {
    // Pinned as a list rather than spot-checked, so that adding a field to the
    // schema fails here and a human has to justify it in the diff. This is the
    // same mechanism as the wire allowlist: equality, not containment.
    const parsed = ReconcileItemSchema.parse({
      ...valid,
      lineStart: 10,
      lineEnd: 12,
      rationale: "The handler retries without a backoff.",
    });

    expect(Object.keys(parsed).sort()).toEqual([
      "atomId",
      "filePath",
      "lineEnd",
      "lineStart",
      "rationale",
      "verdict",
    ]);
  });

  it("is exactly two fields on the request itself", () => {
    const parsed = ReconcileRequestSchema.parse({ items: [valid] });
    expect(Object.keys(parsed).sort()).toEqual(["items", "trigger"]);
  });
});

describe("no field accepts source code", () => {
  // Every name somebody would reach for when they want to send a piece of the
  // file. `.strict()` makes each one a refusal rather than a field silently
  // dropped — and silently dropped is the worse outcome, because it looks like
  // acceptance to whoever sent it, and the caller keeps sending.
  const smuggling = [
    "snippet",
    "code",
    "diff",
    "content",
    "contents",
    "excerpt",
    "source",
    "sourceQuote",
    "hash",
    "contentHash",
    "body",
    "text",
    "before",
    "after",
    "context",
    "lines",
  ];

  it.each(smuggling)("refuses an item carrying %s", (field) => {
    const result = ReconcileItemSchema.safeParse({
      ...valid,
      [field]: "export function f() { return 1; }",
    });
    expect(result.success).toBe(false);
  });

  it.each(smuggling)("refuses a request carrying %s", (field) => {
    const result = ReconcileRequestSchema.safeParse({
      items: [valid],
      [field]: "export function f() { return 1; }",
    });
    expect(result.success).toBe(false);
  });

  it("refuses an unknown field on the resolve body too", () => {
    expect(
      ResolveFindingSchema.safeParse({ status: "dismissed", snippet: "x" })
        .success,
    ).toBe(false);
  });
});

describe("the rationale, the one free-text field", () => {
  it("accepts one short line of prose", () => {
    expect(
      ReconcileItemSchema.safeParse({
        ...valid,
        rationale: "The retry loop has no backoff.",
      }).success,
    ).toBe(true);
  });

  it("refuses a rationale past the cap", () => {
    expect(
      ReconcileItemSchema.safeParse({
        ...valid,
        rationale: "a".repeat(RATIONALE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["a newline", "function f() {\nreturn 1;\n}"],
    ["a tab", "if (x)\treturn;"],
    ["a carriage return", "a\rb"],
    ["only whitespace", "   "],
  ])("refuses a rationale containing %s", (_name, rationale) => {
    expect(ReconcileItemSchema.safeParse({ ...valid, rationale }).success).toBe(
      false,
    );
  });

  // The database caps the length; this schema is what enforces the shape. Both
  // controls are deliberate and neither is redundant: the cap survives a bug in
  // this file, and the shape rule survives a client that talks to the database
  // through some future path.
  it("is capped at 280, the same number the database enforces", () => {
    expect(RATIONALE_MAX_CHARS).toBe(280);
  });
});

describe("a violation cites the lines that disprove the atom", () => {
  it("refuses a violated verdict with no lines", () => {
    const result = ReconcileItemSchema.safeParse({
      ...valid,
      verdict: "violated",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a violated verdict that cites lines", () => {
    expect(
      ReconcileItemSchema.safeParse({
        ...valid,
        verdict: "violated",
        lineStart: 40,
        lineEnd: 44,
      }).success,
    ).toBe(true);
  });

  // Coverage may cite a region — an agent that looked at lines 10-20 and found
  // no counter-example is allowed to say where it looked.
  it("accepts a non-violation that cites lines anyway", () => {
    expect(
      ReconcileItemSchema.safeParse({ ...valid, lineStart: 10, lineEnd: 20 })
        .success,
    ).toBe(true);
  });

  it("refuses a half-given span", () => {
    expect(
      ReconcileItemSchema.safeParse({ ...valid, lineStart: 10 }).success,
    ).toBe(false);
    expect(
      ReconcileItemSchema.safeParse({ ...valid, lineEnd: 10 }).success,
    ).toBe(false);
  });

  it("refuses a span that ends before it starts", () => {
    expect(
      ReconcileItemSchema.safeParse({
        ...valid,
        verdict: "violated",
        lineStart: 44,
        lineEnd: 40,
      }).success,
    ).toBe(false);
  });

  it("refuses line zero", () => {
    expect(
      ReconcileItemSchema.safeParse({
        ...valid,
        verdict: "violated",
        lineStart: 0,
        lineEnd: 4,
      }).success,
    ).toBe(false);
  });
});

describe("the path is a pointer, and the server has no tree to check it against", () => {
  it.each(["/etc/passwd", "/abs/x.ts", "../x.ts", "a/../b.ts", ""])(
    "refuses %s",
    (filePath) => {
      expect(
        ReconcileItemSchema.safeParse({ ...valid, filePath }).success,
      ).toBe(false);
    },
  );

  // The regression this keeps: the check constraint's regex was once written
  // `(^|/)..(/|$)` — the escapes eaten by a template literal — which matches
  // any two-character path segment. Every `src/db/…` path in this repository
  // would have been refused as traversal.
  it.each(["src/db/x.ts", "a/bc/d.ts", "src/..hidden/x.ts", "src/a..b/x.ts"])(
    "accepts %s",
    (filePath) => {
      expect(
        ReconcileItemSchema.safeParse({ ...valid, filePath }).success,
      ).toBe(true);
    },
  );
});

describe("the path cannot be a second free-text field", () => {
  /**
   * `filePath` is 1024 characters and it *is* serialised back out, which is the
   * asymmetry that made this worth a test of its own: the strictly-validated
   * field is withheld from callers and this one is handed to every one of them.
   * A path with a newline in it is a snippet with a filename on the front.
   */
  it.each([
    ["a newline", "src/a.ts\nexport const KEY = process.env.SECRET;"],
    ["a tab", "src/a.ts\tif (x) return;"],
    ["U+2028", "src/a.ts\u2028more"],
    ["a bidi override", "src/\u202eannoc.ts"],
  ])("refuses a filePath containing %s", (_name, filePath) => {
    expect(ReconcileItemSchema.safeParse({ ...valid, filePath }).success).toBe(
      false,
    );
  });

  it("refuses a whole file's worth of text in the path", () => {
    const source = Array.from(
      { length: 20 },
      (_, i) => `  const line${i} = ${i};`,
    ).join("\n");
    expect(
      ReconcileItemSchema.safeParse({
        ...valid,
        filePath: `src/a.ts\n${source}`,
      }).success,
    ).toBe(false);
  });
});

describe("the response", () => {
  /**
   * `rationale` is absent from what is served back, and its absence is
   * load-bearing rather than an oversight.
   *
   * It is written once, for the human working the queue. Serving it would make
   * the one free-text field on this path readable by the next agent that calls
   * a list endpoint — which is exactly the instruction channel
   * `docs/02-principles.md` (13) is about. Being in `WIRE_ALLOWLIST` is the
   * record that a reviewer saw the column, never permission to serialise it.
   */
  it("never carries the rationale back out", () => {
    expect(Object.keys(FindingSchema.shape)).not.toContain("rationale");
  });

  it("does not leak the org", () => {
    expect(Object.keys(FindingSchema.shape)).not.toContain("orgId");
  });

  it("offers a human two answers and no reopen", () => {
    expect(ResolveFindingSchema.safeParse({ status: "accepted" }).success).toBe(
      true,
    );
    expect(
      ResolveFindingSchema.safeParse({ status: "dismissed" }).success,
    ).toBe(true);
    for (const status of ["open", "recorded", "reopened"]) {
      expect(ResolveFindingSchema.safeParse({ status }).success).toBe(false);
    }
  });
});

describe("the trigger is analytics, never control", () => {
  it("defaults rather than being required, because nothing reads it", () => {
    expect(ReconcileRequestSchema.parse({ items: [valid] }).trigger).toBe(
      "agent",
    );
  });

  it("refuses a value outside the vocabulary", () => {
    expect(
      ReconcileRequestSchema.safeParse({ items: [valid], trigger: "cron" })
        .success,
    ).toBe(false);
  });
});

describe("the request is bounded", () => {
  it("refuses an empty submission", () => {
    expect(ReconcileRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it("refuses a submission past the request bound", () => {
    const items = Array.from({ length: 65 }, () => valid);
    expect(ReconcileRequestSchema.safeParse({ items }).success).toBe(false);
  });
});

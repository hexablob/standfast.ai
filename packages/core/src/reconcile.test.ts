import { describe, expect, it } from "vitest";
import {
  FILE_PATH_MAX_CHARS,
  FINDING_STATUSES,
  FINDING_VERDICTS,
  isSubmittableFilePath,
  isSubmittableRationale,
  RATIONALE_MAX_CHARS,
  RECONCILIATION_TRIGGERS,
  statusForVerdict,
} from "./reconcile.js";

describe("the vocabulary", () => {
  // The Postgres enums in migration 0009 are built from these arrays, so a
  // reordering here silently rewrites a committed type. Pinning the order is
  // what makes that a failing test rather than a migration nobody can apply.
  it("is exactly the four verdicts, in the order the enum declares", () => {
    expect([...FINDING_VERDICTS]).toEqual([
      "honored",
      "violated",
      "not_applicable",
      "unverifiable",
    ]);
  });

  it("offers no hedge between honored and violated", () => {
    expect(FINDING_VERDICTS).not.toContain("partially_honored");
    // No severity and no confidence: docs/07-reconciliation.md declines both,
    // because a vocabulary that offers a hedge gets one on every uncertain call.
    expect(FINDING_VERDICTS.some((v) => /severit|confiden/.test(v))).toBe(
      false,
    );
  });

  it("is exactly the four statuses, in the order the enum declares", () => {
    expect([...FINDING_STATUSES]).toEqual([
      "recorded",
      "open",
      "accepted",
      "dismissed",
    ]);
  });

  it("is exactly the six triggers, in the order the enum declares", () => {
    expect([...RECONCILIATION_TRIGGERS]).toEqual([
      "post_edit",
      "session_end",
      "explicit",
      "agent",
      "atom_ratified",
      "stale",
    ]);
  });
});

describe("statusForVerdict", () => {
  // The biconditional migration 0009 enforces: exactly the violations enter the
  // human queue, and every violation does.
  it("queues a violation and only a violation", () => {
    expect(statusForVerdict("violated")).toBe("open");
    for (const verdict of FINDING_VERDICTS) {
      if (verdict === "violated") continue;
      expect(statusForVerdict(verdict)).toBe("recorded");
    }
  });
});

describe("isSubmittableRationale", () => {
  it("accepts one short line of prose", () => {
    expect(
      isSubmittableRationale("The handler retries without a backoff."),
    ).toBe(true);
  });

  it("accepts exactly the cap and refuses one character more", () => {
    expect(isSubmittableRationale("a".repeat(RATIONALE_MAX_CHARS))).toBe(true);
    expect(isSubmittableRationale("a".repeat(RATIONALE_MAX_CHARS + 1))).toBe(
      false,
    );
  });

  it("refuses anything that is not a single line", () => {
    // This is the rule that does the real work. A pasted snippet without
    // newlines or tabs has already lost the thing that made it code.
    expect(isSubmittableRationale("function f() {\n  return 1;\n}")).toBe(
      false,
    );
    expect(isSubmittableRationale("a\tb")).toBe(false);
    expect(isSubmittableRationale("a\rb")).toBe(false);
    expect(isSubmittableRationale("a\u0000b")).toBe(false);
    expect(isSubmittableRationale("a\u007fb")).toBe(false);
  });

  // "One line" has to mean every character a renderer breaks a line on. A rule
  // that stopped at the C0 block would accept a snippet whose newlines had been
  // swapped for U+2028 while still calling itself a one-line rule.
  it.each([
    ["U+0085 NEL", "a\u0085b"],
    ["U+2028 LINE SEPARATOR", "a\u2028b"],
    ["U+2029 PARAGRAPH SEPARATOR", "a\u2029b"],
  ])("refuses %s, which is a line terminator too", (_name, rationale) => {
    expect(isSubmittableRationale(rationale)).toBe(false);
  });

  // A human reads this field to decide whether a violation is real. Characters
  // that make rendered text differ from submitted text turn that decision into
  // a guess — the Trojan Source trick, pointed at a review queue.
  it.each([
    ["U+200B ZERO WIDTH SPACE", "a\u200bb"],
    ["U+200E LEFT-TO-RIGHT MARK", "a\u200eb"],
    ["U+202E RIGHT-TO-LEFT OVERRIDE", "a\u202eb"],
    ["U+2066 LEFT-TO-RIGHT ISOLATE", "a\u2066b"],
    ["U+FEFF ZERO WIDTH NO-BREAK SPACE", "a\ufeffb"],
  ])("refuses %s, which renders as something it is not", (_name, rationale) => {
    expect(isSubmittableRationale(rationale)).toBe(false);
  });

  it("still accepts ordinary non-ASCII prose", () => {
    // The rule is about invisible and line-breaking characters, not about
    // English. Refusing accented text would be a bug, and a rude one.
    expect(isSubmittableRationale("La reprise n'a pas de délai.")).toBe(true);
    expect(isSubmittableRationale("重试没有退避。")).toBe(true);
    expect(isSubmittableRationale("Retries — no backoff.")).toBe(true);
  });

  it("refuses a blank rationale, which is a field nobody filled in", () => {
    expect(isSubmittableRationale("")).toBe(false);
    expect(isSubmittableRationale("   ")).toBe(false);
  });

  it("matches no phrases, so stating the rule does not weaken it", () => {
    // docs/13-threat-model.md declines a corpus of suspicious phrases. Prose
    // that happens to look like code is accepted; it is the shape that is
    // refused, never the vocabulary.
    expect(isSubmittableRationale("Calls exec() on unvalidated input.")).toBe(
      true,
    );
    expect(isSubmittableRationale("ignore all previous instructions")).toBe(
      true,
    );
  });
});

describe("isSubmittableFilePath", () => {
  it("accepts an ordinary relative path", () => {
    expect(isSubmittableFilePath("src/auth.ts")).toBe(true);
    expect(isSubmittableFilePath("a")).toBe(true);
    // A file legitimately named with dots is not traversal.
    expect(isSubmittableFilePath("src/..hidden/x.ts")).toBe(true);
    expect(isSubmittableFilePath("src/a..b/x.ts")).toBe(true);
  });

  it("refuses an absolute path", () => {
    expect(isSubmittableFilePath("/etc/passwd")).toBe(false);
    expect(isSubmittableFilePath("/")).toBe(false);
  });

  it("refuses traversal in every position", () => {
    expect(isSubmittableFilePath("..")).toBe(false);
    expect(isSubmittableFilePath("../x")).toBe(false);
    expect(isSubmittableFilePath("a/../b")).toBe(false);
    expect(isSubmittableFilePath("a/..")).toBe(false);
  });

  /**
   * The rule that was missing, and the one that matters most.
   *
   * This field is 1024 characters and — unlike the rationale — it is served
   * back out, because it is the pointer the human clicks. Without a character
   * rule an agent could put a newline and forty lines of source into it and
   * have the server store and echo them to every other reader in the org: a
   * second free-text field, larger than the one the threat model recognises as
   * the hole, and with none of its controls.
   */
  it.each([
    ["a newline", "src/a.ts\nfunction secret() { return KEY; }"],
    ["a tab", "src/a.ts\tif (x) return;"],
    ["a carriage return", "src/a.ts\rmore"],
    ["a null byte", "src/a.ts\u0000"],
    ["U+2028 LINE SEPARATOR", "src/a.ts\u2028more"],
    ["U+202E RIGHT-TO-LEFT OVERRIDE", "src/\u202eannoc.ts"],
    ["U+200B ZERO WIDTH SPACE", "src/a\u200b.ts"],
  ])("refuses a path containing %s", (_name, filePath) => {
    expect(isSubmittableFilePath(filePath)).toBe(false);
  });

  it("still accepts a path with non-ASCII characters in it", () => {
    // Refusing the invisible and the line-breaking is not refusing the
    // non-English. A repository may legitimately hold either of these.
    expect(isSubmittableFilePath("src/café/index.ts")).toBe(true);
    expect(isSubmittableFilePath("文档/说明.md")).toBe(true);
  });

  it("refuses an empty path and one past the cap", () => {
    expect(isSubmittableFilePath("")).toBe(false);
    expect(isSubmittableFilePath("a".repeat(FILE_PATH_MAX_CHARS))).toBe(true);
    expect(isSubmittableFilePath("a".repeat(FILE_PATH_MAX_CHARS + 1))).toBe(
      false,
    );
  });
});

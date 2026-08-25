import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDuration, quoteInSection } from "./commands.js";
import { configPath, redactKey, saveConfig } from "./config.js";
import {
  compareAtoms,
  type ExportAtom,
  exportDestination,
  readOwnedManifest,
  safeJoin,
} from "./export.js";
import { OPTIONS, run, USAGE } from "./run.js";

/**
 * These need no server. Anything that does is an integration test in
 * packages/api, where the app can be driven through an injected fetch.
 */

let home = "";
const originalXdg = process.env["XDG_CONFIG_HOME"];
const originalKey = process.env["STANDFAST_API_KEY"];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "standfast-cli-"));
  process.env["XDG_CONFIG_HOME"] = home;
  delete process.env["STANDFAST_API_KEY"];
});

afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
  if (originalKey !== undefined) {
    process.env["STANDFAST_API_KEY"] = originalKey;
  }
});

describe("argument handling", () => {
  it("exits 2 with usage when given nothing", async () => {
    expect(await run([])).toBe(2);
  });

  it("exits 0 for --help", async () => {
    expect(await run(["--help"])).toBe(0);
  });

  it("exits 2 for an unknown command", async () => {
    expect(await run(["frobnicate"])).toBe(2);
  });

  it("exits 2 for an unknown flag rather than ignoring it", async () => {
    expect(await run(["project", "ls", "--wat"])).toBe(2);
  });

  // The strictness above is why this matters. A flag a command reads but
  // OPTIONS never declares is not merely ignored — `parseArgs` rejects the
  // whole invocation, so the flag is unusable and the usage text lies about
  // it. `--events` and `--limit` shipped that way. Scanning the source is
  // crude, but `ctx.flags["…"]` is the one shape every command uses to reach
  // a flag, and the alternative is one behavioural test per flag.
  //
  // It catches only literal reads. `pageQuery` reaches `--limit` and
  // `--offset` through a loop variable, so those two are covered by the usage
  // test below instead — which is the better net anyway, since a flag being
  // documented is what makes a user type it.
  it("declares every flag the commands read", async () => {
    // Every module that reaches ctx.flags.
    const modules = ["commands.ts", "export.ts", "sync.ts"];
    const read = new Set<string>();
    for (const module of modules) {
      const source = await readFile(new URL(module, import.meta.url), "utf8");
      for (const match of source.matchAll(/ctx\.flags\["([^"]+)"\]/g)) {
        read.add(match[1] as string);
      }
    }
    // Guards the regex itself: a rename that breaks the pattern would
    // otherwise make this test pass by finding nothing.
    expect(read.size).toBeGreaterThan(5);
    expect([...read].filter((flag) => !(flag in OPTIONS))).toEqual([]);
  });

  // The other half of the same bug, and the half a user actually meets: the
  // usage text is the contract, so a `--flag` printed there had better parse.
  // This is what covers `--limit` and `--offset`, which the source scan above
  // cannot see.
  it("declares every flag the usage text advertises", () => {
    const documented = new Set(
      [...USAGE.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string),
    );
    expect(documented.size).toBeGreaterThan(5);
    expect([...documented].filter((flag) => !(flag in OPTIONS))).toEqual([]);
  });

  // A command needing credentials must say so, not fail later with a 401
  // whose cause is ambiguous.
  it("exits 2 when not logged in", async () => {
    expect(await run(["project", "ls"])).toBe(2);
  });
});

describe("credential storage", () => {
  it("writes the config 0600 and only to the config dir", async () => {
    await saveConfig({ baseUrl: "http://x", apiKey: "sf_sk_secret" });

    const path = configPath();
    expect(path.startsWith(home)).toBe(true);

    // The umask can mask a mode passed to writeFile, so this is asserted
    // rather than assumed. A world-readable file holding an API key is the
    // whole problem.
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);

    const written = JSON.parse(await readFile(path, "utf8")) as {
      apiKey: string;
    };
    expect(written.apiKey).toBe("sf_sk_secret");
  });

  it("redacts a key to something recognisable but unusable", () => {
    const redacted = redactKey("sf_sk_abcdefghijklmnop");
    expect(redacted).toContain("sf_sk_");
    expect(redacted).not.toContain("ijklmnop");
  });

  it("login stores the credential and reports exit 0", async () => {
    const code = await run(["login", "--key", "sf_sk_x", "--url", "http://h"]);
    expect(code).toBe(0);

    const written = JSON.parse(await readFile(configPath(), "utf8")) as {
      baseUrl: string;
    };
    expect(written.baseUrl).toBe("http://h");
  });

  it("logout removes it", async () => {
    await run(["login", "--key", "sf_sk_x"]);
    expect(await run(["logout"])).toBe(0);
    await expect(stat(configPath())).rejects.toThrow();
  });

  it("login without a key is a usage error, not a saved empty credential", async () => {
    expect(await run(["login"])).toBe(2);
    await expect(stat(configPath())).rejects.toThrow();
  });
});

describe("export path safety", () => {
  // doc.path comes from the server. Writing it unchecked would let a
  // compromised or merely buggy server choose where the client writes.
  it("refuses a path that escapes the export directory", () => {
    expect(() => safeJoin("/tmp/export", "../../.ssh/authorized_keys")).toThrow(
      /outside the export directory/,
    );
    expect(() => safeJoin("/tmp/export", "/etc/passwd")).toThrow(
      /outside the export directory/,
    );
  });

  it("allows an ordinary nested path", () => {
    expect(safeJoin("/tmp/export", "docs/a/b.md")).toBe(
      "/tmp/export/docs/a/b.md",
    );
  });

  it("refuses a path that resolves to the directory itself", () => {
    expect(() => safeJoin("/tmp/export", ".")).toThrow();
  });

  // `.standfast/` is reserved for the atom projection. A document stored there
  // would collide with it, and a collision that fails quietly is data loss.
  it("refuses a document path under the reserved .standfast/", () => {
    expect(() =>
      exportDestination("/tmp/export/p", ".standfast/atoms/x.md"),
    ).toThrow(/reserved/);
  });

  it("routes an ordinary document path through the escape check", () => {
    expect(exportDestination("/tmp/export/p", "docs/a.md")).toBe(
      "/tmp/export/p/docs/a.md",
    );
    expect(() => exportDestination("/tmp/export/p", "../a.md")).toThrow(
      /outside the export directory/,
    );
  });
});

describe("export ordering", () => {
  const atom = (over: Partial<ExportAtom>): ExportAtom => ({
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    documentId: "doc",
    sectionId: "s1",
    statement: "x",
    kind: "decision",
    status: "canonical",
    sourceQuote: "q",
    sourceSpan: { start: 0, end: 1 },
    ratifiedAt: null,
    supersededBy: null,
    ...over,
  });

  // The API returns atoms newest-first, which is right for a listing and
  // wrong for a record: a re-export after any write would reorder every file.
  it("orders by section, active before superseded, span start, then id", () => {
    const ordinals = new Map([
      ["s1", 0],
      ["s2", 1],
    ]);
    const sorted = [
      atom({ id: "f", sectionId: "s2" }),
      atom({
        id: "e",
        status: "superseded",
        supersededBy: "x",
        sourceSpan: { start: 5, end: 6 },
      }),
      atom({ id: "d", sourceSpan: { start: 90, end: 91 } }),
      atom({ id: "c", sourceSpan: { start: 10, end: 11 } }),
      atom({ id: "b", sourceSpan: { start: 10, end: 11 } }),
    ].sort(compareAtoms((id) => ordinals.get(id) ?? 99));
    expect(sorted.map((a) => a.id)).toEqual(["b", "c", "d", "e", "f"]);
  });
});

describe("export ownership sentinel", () => {
  // Export deletes what it did not write, so it refuses a directory it cannot
  // prove it wrote. `standfast export ~` must not delete a home directory.
  it("treats a missing or empty target as ours to create", async () => {
    expect(await readOwnedManifest(join(home, "does-not-exist"))).toBeNull();
    const empty = await mkdtemp(join(tmpdir(), "standfast-export-"));
    expect(await readOwnedManifest(empty)).toBeNull();
  });

  it("refuses a non-empty target without a parseable manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standfast-export-"));
    await writeFile(join(dir, "stray.txt"), "not ours", "utf8");
    await expect(readOwnedManifest(dir)).rejects.toThrow(/standfast\.json/);

    await writeFile(join(dir, "standfast.json"), "{ not json", "utf8");
    await expect(readOwnedManifest(dir)).rejects.toThrow(/standfast\.json/);
  });

  it("returns the previous manifest when the target is a previous export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "standfast-export-"));
    await writeFile(
      join(dir, "standfast.json"),
      `${JSON.stringify({ standfast: "export/v1", server: "", projects: [] })}\n`,
      "utf8",
    );
    const manifest = await readOwnedManifest(dir);
    expect(manifest?.standfast).toBe("export/v1");
  });
});

/** Runs the CLI and returns what it put on stderr along with the exit code. */
async function onStderr(...argv: string[]) {
  const chunks: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(argv), stderr: chunks.join("") };
  } finally {
    process.stderr.write = real;
  }
}

describe("ratification", () => {
  it("routes every ratification command", async () => {
    // Each stops at its own usage check rather than the network, so what is
    // being asserted is that the word reached a handler at all: an unrouted
    // command exits 2 as well, but says "Unknown command" on the way out.
    for (const command of [
      "queue",
      "next",
      "ratify",
      "reject",
      "retire",
      "ratification",
    ]) {
      const { stderr } = await onStderr(command);
      expect(stderr).not.toContain("Unknown command");
    }
  });

  it("refuses a reject reason outside the five", async () => {
    // A typo is the flag the human got wrong, not a 400 about a JSON field
    // they never typed.
    const { code, stderr } = await onStderr(
      "reject",
      "00000000-0000-0000-0000-000000000000",
      "--reason",
      "not_convinced",
    );
    expect(code).toBe(2);
    expect(stderr).toContain("--reason must be one of");
    expect(stderr).toContain("not_a_decision");

    for (const reason of [
      "not_true",
      "duplicate",
      "not_a_decision",
      "wrong_severity",
      "document_is_wrong",
    ]) {
      const res = await onStderr(
        "reject",
        "00000000-0000-0000-0000-000000000000",
        "--reason",
        reason,
      );
      expect(res.stderr).not.toContain("--reason must be one of");
    }
  });

  it("refuses a queue kind outside the three", async () => {
    const { code, stderr } = await onStderr(
      "queue",
      "--project",
      "p",
      "--kind",
      "guideline",
    );
    expect(code).toBe(2);
    expect(stderr).toContain("--kind must be one of");
  });

  it("refuses ratification without --older-than", async () => {
    // The metric has no default window on purpose: docs/02-principles.md (10)
    // leaves the bar unchosen, and a default here would become it.
    expect(await run(["ratification", "--project", "p"])).toBe(2);
    expect(await run(["ratification", "--project", "p", "--older-than"])).toBe(
      2,
    );
  });

  it("converts a humane duration to seconds", () => {
    expect(parseDuration("7d")).toBe(604800);
    expect(parseDuration("36h")).toBe(129600);
    expect(parseDuration("90m")).toBe(5400);
    expect(parseDuration("900s")).toBe(900);
    expect(parseDuration("2w")).toBe(1209600);
    expect(parseDuration("900")).toBe(900);
    expect(parseDuration(" 7d ")).toBe(604800);
  });

  it("refuses a duration it cannot read, rather than guessing", () => {
    // Zero is refused by the API too. "Older than no time at all" is the whole
    // backlog, which is a different question than the one asked.
    for (const bad of ["", "soon", "7 days", "-1", "1.5h", "7y", "0", "d"]) {
      expect(() => parseDuration(bad)).toThrow(/--older-than/);
    }
  });

  it("marks the quote inside its section by code point", () => {
    // The span counts code points. `.slice()` counts UTF-16 code units and
    // would drift by one per astral character, marking the wrong words.
    const body = "# 🚀 Rule\nAlways ship.";
    const start = [...body].indexOf("A");
    expect(
      quoteInSection({
        sourceQuote: "Always ship.",
        sourceSpan: { start, end: start + "Always ship.".length },
        sectionBody: body,
      }),
    ).toBe("# 🚀 Rule\n»Always ship.«");
  });

  it("shows the section unmarked when the span misses the quote", () => {
    const marked = quoteInSection({
      sourceQuote: "Always ship.",
      sourceSpan: { start: 0, end: 4 },
      sectionBody: "# Rule\nAlways ship.",
    });
    expect(marked).toContain("# Rule\nAlways ship.");
    expect(marked).not.toContain("»");
    expect(marked).toContain("Always ship.");
  });
});

import { mkdtemp, readFile as readRealFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@standfast/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "./commands.js";
import {
  gatherLocal,
  journalPath,
  localContentHash,
  parseSyncConfig,
  type SyncDirent,
  type SyncFs,
  syncRun,
} from "./sync.js";
import { type Operation, plan, type Scope, scopeDigest } from "./sync-plan.js";

/**
 * The pure half (`plan`, `scopeDigest`, the config shape) and the one impure
 * property worth proving without a server: the allowlist gates the read.
 * Everything that needs a real API is in packages/api's integration tests.
 */

let home = "";
const originalXdg = process.env["XDG_CONFIG_HOME"];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "standfast-sync-"));
  process.env["XDG_CONFIG_HOME"] = home;
});

afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
});

describe("plan: the docs/10 conflict table, row by row", () => {
  const rows: {
    name: string;
    scope: Scope;
    local: Record<string, string>;
    remote: Record<string, string>;
    expected: Operation[];
  }[] = [
    {
      name: "unchanged | unchanged → nothing",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h1" },
      remote: { "a.md": "h1" },
      expected: [{ op: "noop", path: "a.md" }],
    },
    {
      name: "changed | unchanged → upload, re-base",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h2" },
      remote: { "a.md": "h1" },
      expected: [{ op: "push", path: "a.md" }],
    },
    {
      name: "unchanged | changed → report; write nothing (remote becomes the base)",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h1" },
      remote: { "a.md": "h2" },
      expected: [{ op: "rebase", path: "a.md", hash: "h2" }],
    },
    {
      name: "changed | changed → conflict: write nothing, wait for a human",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h2" },
      remote: { "a.md": "h3" },
      expected: [{ op: "conflict", path: "a.md" }],
    },
    {
      name: "absent | any → report as unseen; nothing is ever deleted remotely",
      scope: { paths: [], base: { "a.md": "h1" } },
      local: {},
      remote: { "a.md": "h2" },
      expected: [{ op: "unseen", path: "a.md" }],
    },
    {
      name: "local new → push",
      scope: { paths: ["a.md"], base: {} },
      local: { "a.md": "h1" },
      remote: {},
      expected: [{ op: "push", path: "a.md" }],
    },
    {
      name: "no base, both sides hold the same bytes → re-base, no upload",
      scope: { paths: ["a.md"], base: {} },
      local: { "a.md": "h1" },
      remote: { "a.md": "h1" },
      expected: [{ op: "rebase", path: "a.md", hash: "h1" }],
    },
    {
      name: "no base, two different bodies → conflict; only a human can order them",
      scope: { paths: ["a.md"], base: {} },
      local: { "a.md": "h1" },
      remote: { "a.md": "h2" },
      expected: [{ op: "conflict", path: "a.md" }],
    },
    {
      name: "unchanged | remote deleted → re-base to absence, upload nothing",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h1" },
      remote: {},
      expected: [{ op: "rebase", path: "a.md", hash: null }],
    },
    {
      name: "changed | remote deleted → conflict",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h2" },
      remote: {},
      expected: [{ op: "conflict", path: "a.md" }],
    },
    {
      name: "gone locally and remotely → the base entry lapses, nothing to report",
      scope: { paths: [], base: { "a.md": "h1" } },
      local: {},
      remote: {},
      expected: [],
    },
    {
      name: "a remote document outside the scope and the journal is ignored",
      scope: { paths: ["a.md"], base: { "a.md": "h1" } },
      local: { "a.md": "h1" },
      remote: { "a.md": "h1", "someone-elses.md": "hx" },
      expected: [{ op: "noop", path: "a.md" }],
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(plan(row.scope, row.local, row.remote)).toEqual(row.expected);
    });
  }

  it("emits operations in path order, deterministically", () => {
    const operations = plan(
      { paths: ["c.md", "a.md"], base: { "b.md": "h" } },
      { "c.md": "h", "a.md": "h" },
      { "b.md": "h2" },
    );
    expect(operations.map((op) => op.path)).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("scopeDigest", () => {
  it("is order-independent and changes when a path is added", () => {
    const digest = scopeDigest(["a.md", "docs/b.md"]);
    expect(scopeDigest(["docs/b.md", "a.md"])).toBe(digest);
    expect(scopeDigest(["a.md", "docs/b.md", "docs/c.md"])).not.toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sync config", () => {
  it("accepts exactly project and include", () => {
    expect(
      parseSyncConfig(
        JSON.stringify({ project: "p", include: ["docs/**/*.md"] }),
        "f",
      ),
    ).toEqual({ project: "p", include: ["docs/**/*.md"] });
  });

  it("refuses unknown keys — exclude above all", () => {
    expect(() =>
      parseSyncConfig(
        JSON.stringify({ project: "p", include: ["*.md"], exclude: ["x"] }),
        "f",
      ),
    ).toThrow(/exclude/);
  });

  it("refuses a missing project, an empty include and non-JSON", () => {
    expect(() =>
      parseSyncConfig(JSON.stringify({ include: ["*.md"] }), "f"),
    ).toThrow(/"project"/);
    expect(() =>
      parseSyncConfig(JSON.stringify({ project: "p", include: [] }), "f"),
    ).toThrow(/"include"/);
    expect(() => parseSyncConfig("{ not json", "f")).toThrow(/JSON/);
  });
});

describe("journal placement", () => {
  it("keys by folder realpath under the config dir, never in the repo", () => {
    const one = journalPath("/repo/one");
    const two = journalPath("/repo/two");
    expect(one.startsWith(join(home, "standfast", "sync"))).toBe(true);
    expect(one).not.toBe(two);
    expect(one).not.toContain("/repo/");
    expect(one.endsWith("config.json")).toBe(false);
  });
});

/**
 * The check `docs/10-sync-daemon.md` asks for by name: a fixture tree holding
 * an unmatched private file, walked through a filesystem stub that throws on
 * any read outside the resolved allowlist, and the run completes. A stub that
 * throws is the difference between "we filter it out" and "we never touched
 * it".
 */
describe("the allowlist gates the read", () => {
  const root = "/repo";
  const projectId = "00000000-0000-0000-0000-000000000001";
  const files: Record<string, string> = {
    "standfast.sync.json": JSON.stringify({
      project: projectId,
      include: ["*.md", "docs/**/*.md"],
    }),
    "CLAUDE.md": "# Rules\nShip.",
    "docs/a.md": "# A\nAlpha.",
    "docs/deep/b.md": "# B\nBeta.",
    "notes/2026-compensation.md": "PRIVATE",
    "README.txt": "not markdown",
  };
  const allowed = new Set([
    "standfast.sync.json",
    "CLAUDE.md",
    "docs/a.md",
    "docs/deep/b.md",
  ]);

  const dirent = (
    name: string,
    kind: "file" | "dir" | "symlink",
  ): SyncDirent => ({
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  });

  const stub: SyncFs = {
    async readdir(dir) {
      const rel = dir === root ? "" : dir.slice(root.length + 1);
      const entries = new Map<string, "file" | "dir">();
      for (const path of Object.keys(files)) {
        if (rel !== "" && !path.startsWith(`${rel}/`)) {
          continue;
        }
        const rest = rel === "" ? path : path.slice(rel.length + 1);
        const head = rest.split("/")[0] as string;
        entries.set(head, rest.includes("/") ? "dir" : "file");
      }
      const listed = [...entries].map(([name, kind]) => dirent(name, kind));
      if (rel === "") {
        // A symlink whose name matches a glob. Followed, it would be a read
        // outside the allowlist and this suite would fail.
        listed.push(dirent("sneaky-link.md", "symlink"));
      }
      return listed;
    },
    async readFile(path) {
      const rel = path.slice(root.length + 1);
      if (!allowed.has(rel)) {
        throw new Error(`read outside the allowlist: ${rel}`);
      }
      const body = files[rel];
      if (body === undefined) {
        throw new Error(`no such file: ${rel}`);
      }
      return body;
    },
    async realpath(path) {
      return path;
    },
  };

  /** A server that remembers: `server` maps path → contentHash across runs. */
  function fetchStub(server: Record<string, string>) {
    const puts: string[] = [];
    const fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (
        req.method === "GET" &&
        url.pathname.endsWith("/documents/manifest")
      ) {
        const items = Object.entries(server).map(([path, contentHash]) => ({
          id: "00000000-0000-0000-0000-00000000000d",
          path,
          contentHash,
        }));
        return Response.json({
          items,
          total: items.length,
          returned: items.length,
          truncated: false,
        });
      }
      if (req.method === "PUT" && url.pathname.endsWith("/documents")) {
        const body = (await req.json()) as { path: string; body: string };
        puts.push(body.path);
        server[body.path] = localContentHash(body.body);
        return Response.json({
          id: "00000000-0000-0000-0000-00000000000d",
          orgId: "00000000-0000-0000-0000-00000000000a",
          projectId,
          path: body.path,
          title: body.path,
          body: body.body,
          contentHash: server[body.path],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      }
      throw new Error(`unexpected request: ${req.method} ${url.pathname}`);
    }) as typeof globalThis.fetch;
    return { fetch, puts };
  }

  const ctxFor = (
    fetch: typeof globalThis.fetch,
    flags: Ctx["flags"] = {},
  ): Ctx => ({
    client: () =>
      createClient({ baseUrl: "http://sync.test", apiKey: "sf_sk_t", fetch }),
    config: { baseUrl: "http://sync.test", apiKey: "sf_sk_t" },
    format: "json",
    flags,
    args: [root],
  });

  it("gathers matched paths without ever reading the private file", async () => {
    const { paths } = await gatherLocal(root, ["*.md", "docs/**/*.md"], stub);
    expect(paths).toEqual(["CLAUDE.md", "docs/a.md", "docs/deep/b.md"]);
  });

  it("a full run completes against the throwing stub", async () => {
    const server: Record<string, string> = {};
    const first = fetchStub(server);
    // First run: the plan prints, nothing uploads, the message names --accept.
    await expect(syncRun(ctxFor(first.fetch), stub)).rejects.toThrow(
      /standfast sync --accept$/,
    );
    expect(first.puts).toEqual([]);
    expect(server).toEqual({});

    // Accepted: the matched set uploads — and only it. The private file was
    // never read; the stub proved it by not throwing.
    const second = fetchStub(server);
    await syncRun(ctxFor(second.fetch, { accept: true }), stub);
    expect(second.puts.sort()).toEqual([
      "CLAUDE.md",
      "docs/a.md",
      "docs/deep/b.md",
    ]);

    // The journal armed the scope: a third run is a no-op needing no flag.
    const third = fetchStub(server);
    await syncRun(ctxFor(third.fetch), stub);
    expect(third.puts).toEqual([]);
    const journal = JSON.parse(
      await readRealFile(journalPath(root), "utf8"),
    ) as { base: Record<string, string> };
    expect(Object.keys(journal.base).sort()).toEqual([
      "CLAUDE.md",
      "docs/a.md",
      "docs/deep/b.md",
    ]);
  });

  it("refuses a directory entry that escapes the root", async () => {
    const escaping: SyncFs = {
      ...stub,
      async readdir(dir) {
        return dir === root ? [dirent("..", "dir")] : [];
      },
    };
    await expect(gatherLocal(root, ["*.md"], escaping)).rejects.toThrow(
      /sync root/,
    );
  });
});

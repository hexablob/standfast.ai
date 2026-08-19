import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeJoin } from "./commands.js";
import { configPath, redactKey, saveConfig } from "./config.js";
import { run } from "./run.js";

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
});

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "@standfast/cli";
import { closePool, generateApiKey } from "@standfast/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * Drives the real CLI against the real API.
 *
 * The unit tests in packages/cli prove the argument handling and the
 * credential file. They cannot prove a command actually works, because that
 * needs a server — so it is proven here, where one exists. The CLI's fetch is
 * injected into the Hono app, so no socket is involved.
 *
 * Here rather than in packages/cli because of the licence direction: this
 * package is AGPL-3.0 and may depend on the Apache-2.0 CLI. The reverse would
 * contaminate a package that ships to users' machines.
 */

const adminUrl = process.env["DATABASE_URL"] ?? "";
const app = createApp();
const fetchIntoApp = ((input: Request) =>
  app.request(input)) as typeof globalThis.fetch;

let home = "";
let workdir = "";
let projectId = "";
let atomId = "";
let humanKey = "";
// A second credential, because the 403 on resolve is about the actor's kind
// and cannot be provoked with the human key the rest of the file uses.
let agentKey = "";

const originalXdg = process.env["XDG_CONFIG_HOME"];
const originalKey = process.env["STANDFAST_API_KEY"];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "standfast-e2e-home-"));
  workdir = await mkdtemp(join(tmpdir(), "standfast-e2e-work-"));
  process.env["XDG_CONFIG_HOME"] = home;

  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(`DO $$ BEGIN
      CREATE ROLE standfast_test LOGIN PASSWORD 'standfast_test' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.query('GRANT "standfast_app" TO standfast_test');

    const suffix = `${Date.now()}-${process.pid}`;
    const org = await db.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $1) returning id",
      [`cli-${suffix}`],
    );
    const actor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', 'h') returning id",
      [org.rows[0]?.id],
    );

    // Production creates this with the org (bootstrap.ts, migration 0004), so a
    // test that creates an org creates one too. putDocument resolves it to
    // attribute extraction jobs, and deliberately refuses to mint one itself.
    const extractor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor') returning id",
      [org.rows[0]?.id],
    );
    const generated = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
       values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [
        org.rows[0]?.id,
        actor.rows[0]?.id,
        `${generated.prefix}-${suffix}`,
        generated.hash,
      ],
    );
    const forAgent = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
       values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [
        org.rows[0]?.id,
        extractor.rows[0]?.id,
        `${forAgent.prefix}-agent-${suffix}`,
        forAgent.hash,
      ],
    );
    agentKey = forAgent.key;

    // Environment beats the config file, which is what lets CI run without
    // writing a credential to disk.
    humanKey = generated.key;
    process.env["STANDFAST_API_KEY"] = generated.key;
  } finally {
    await db.end();
  }

  const url = new URL(adminUrl);
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  process.env["DATABASE_URL"] = adminUrl;
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
  if (originalKey === undefined) {
    delete process.env["STANDFAST_API_KEY"];
  } else {
    process.env["STANDFAST_API_KEY"] = originalKey;
  }
});

const cli = (...argv: string[]) => run(argv, { fetch: fetchIntoApp });

/** Straight at the API, for the fixtures the CLI has no command to build. */
const api = (path: string, key: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
  });

/**
 * Runs the CLI with both streams diverted, because a command is only proven by
 * what it printed: the exit code alone cannot tell an empty queue from a
 * listed one, nor a 403 from any other refusal.
 */
async function capture(...argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await cli(...argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/**
 * A finding needs a canonical atom to point at, and only a `violated` verdict
 * reaches the open queue. Both are made through the API rather than written as
 * SQL, so the fixture cannot stay green while the path a real run takes is
 * broken. `filePath` is what tells one seeded finding from the next.
 */
async function seedOpenFinding(filePath: string): Promise<string> {
  if (!atomId) {
    const docs = (await (
      await api(`/v1/projects/${projectId}/documents`, humanKey)
    ).json()) as { items: { id: string; path: string }[] };
    const documentId =
      docs.items.find((d) => d.path === "docs/notes.md")?.id ?? "";
    const sections = (await (
      await api(`/v1/documents/${documentId}/sections`, humanKey)
    ).json()) as { items: { id: string }[] };

    const created = await api(`/v1/projects/${projectId}/atoms`, humanKey, {
      method: "POST",
      body: JSON.stringify({
        documentId,
        sectionId: sections.items[0]?.id ?? "",
        statement: "Always ship.",
        kind: "convention",
        // Offsets into the section body, which includes its heading line.
        sourceQuote: "Always ship.",
        sourceSpan: { start: 7, end: 19 },
      }),
    });
    expect(created.status).toBe(201);
    atomId = ((await created.json()) as { id: string }).id;

    const ratified = await api(`/v1/atoms/${atomId}/ratify`, humanKey, {
      method: "POST",
    });
    expect(ratified.status).toBe(200);
  }

  const recorded = await api(
    `/v1/projects/${projectId}/reconciliations`,
    humanKey,
    {
      method: "POST",
      body: JSON.stringify({
        items: [
          { atomId, verdict: "violated", filePath, lineStart: 10, lineEnd: 12 },
        ],
      }),
    },
  );
  expect(recorded.status).toBe(201);

  const queue = (await (
    await api(`/v1/projects/${projectId}/findings?status=open`, humanKey)
  ).json()) as { items: { id: string; filePath: string }[] };
  const id = queue.items.find((f) => f.filePath === filePath)?.id ?? "";
  expect(id).not.toBe("");
  return id;
}

describe("standfast end to end", () => {
  it("verifies the credential with whoami", async () => {
    expect(await cli("whoami")).toBe(0);
  });

  it("creates a project and lists it", async () => {
    expect(
      await cli("project", "create", "CLI Test", "--slug", `cli-${Date.now()}`),
    ).toBe(0);
    expect(await cli("project", "ls")).toBe(0);

    // Recover the id the way a user would: read it back through the API.
    const res = await app.request("/v1/projects", {
      headers: { authorization: `Bearer ${process.env["STANDFAST_API_KEY"]}` },
    });
    const projects = (await res.json()) as { items: { id: string }[] };
    projectId = projects.items[0]?.id ?? "";
    expect(projectId).not.toBe("");
  });

  it("pushes a markdown file and lists it", async () => {
    const file = join(workdir, "notes.md");
    await writeFile(file, "# Rule\nAlways ship.\n\n# Second\nMore.", "utf8");

    expect(
      await cli(
        "doc",
        "push",
        file,
        "--project",
        projectId,
        "--path",
        "docs/notes.md",
      ),
    ).toBe(0);
    expect(await cli("doc", "ls", "--project", projectId)).toBe(0);
  });

  // Absolute local paths would ship the operator's home directory to the
  // server and cannot be reconstructed by export.
  it("refuses a file outside the working directory without --path", async () => {
    const stray = join(workdir, "stray.md");
    await writeFile(stray, "# Stray", "utf8");
    expect(await cli("doc", "push", stray, "--project", projectId)).toBe(2);
  });

  it("requires --project rather than guessing", async () => {
    expect(await cli("doc", "ls")).toBe(2);
  });

  // docs/02-principles.md (11): anti-lock-in is only credible if it works
  // before anyone asks for it.
  it("exports every document as markdown the user keeps", async () => {
    const target = join(workdir, "export");
    expect(await cli("export", target)).toBe(0);

    const projects = await readdir(target);
    expect(projects.length).toBeGreaterThan(0);

    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          found.push(full);
        }
      }
    };
    await walk(target);

    expect(found.length).toBeGreaterThan(0);
    // Among them the pushed document, verbatim. The tree also holds the
    // README, the manifest and the atom projections, so the document is
    // found rather than assumed to be first.
    const bodies = await Promise.all(found.map((f) => readFile(f, "utf8")));
    expect(bodies.some((b) => b.includes("Always ship."))).toBe(true);
  });

  it("answers the egress question, and says so when nothing left", async () => {
    // The pipeline has not run here, so the honest answer is that nothing has
    // left — and a self-hosted deployment on local models should get that same
    // answer forever. It has to read as a statement, not as an empty table.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cli("egress", "--project", projectId)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).toContain("Nothing has left this project.");
  });

  // `--events` and `--limit` were documented and read but never declared in
  // OPTIONS, so `parseArgs` rejected the invocation before the command ran.
  // Exit 0 is the assertion that matters: a parse failure can only ever
  // return 2, so reaching the API at all proves the flags are accepted.
  it("accepts --limit and --offset on every listing that advertises them", async () => {
    const listings = [
      ["project", "ls"],
      ["doc", "ls", "--project", projectId],
      ["atom", "ls", "--project", projectId],
      ["findings", "ls", "--project", projectId],
      ["egress", "--project", projectId, "--events"],
    ];
    for (const argv of listings) {
      expect(await cli(...argv, "--limit", "5")).toBe(0);
      // Zero is a legitimate offset — it is the first page — and a check that
      // treated it as missing would quietly page from the wrong place.
      expect(await cli(...argv, "--offset", "0")).toBe(0);
      expect(await cli(...argv, "--limit", "5", "--offset", "1")).toBe(0);
    }
  });

  // A bad page flag is the user's mistake, not the server's. It has to be
  // named as such rather than travelling as `NaN` and returning a 400 about a
  // query parameter nobody typed. `--limit 0` asks for nothing; `--offset 0`
  // is fine, so only the negative case is rejected there.
  it("refuses a --limit or --offset that is not a whole number", async () => {
    // `--limit=-3` rather than `--limit -3`: parseArgs refuses a separate
    // argument that starts with a dash as ambiguous, which is its own exit 2
    // with its own message and would not exercise the check below.
    for (const bad of ["soon", "0", "=-3", "2.5", ""]) {
      const argv = bad.startsWith("=") ? [`--limit${bad}`] : ["--limit", bad];
      const res = await capture("doc", "ls", "--project", projectId, ...argv);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("--limit must be a positive integer");
    }
    for (const bad of ["soon", "=-1", "2.5", ""]) {
      const argv = bad.startsWith("=") ? [`--offset${bad}`] : ["--offset", bad];
      const res = await capture("doc", "ls", "--project", projectId, ...argv);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("--offset must be a non-negative integer");
    }
  });

  // The flags parsing is only half of it. A flag that is accepted and then
  // dropped on the floor is the same bug one step further along, so this
  // seeds a second document and asserts the two pages hold different rows.
  it("actually pages: --limit 1 and --offset 1 return different rows", async () => {
    await writeFile(join(workdir, "second.md"), "# Second\n\nAlso ship.\n");
    // --path because the file sits outside the working directory, which push
    // refuses to guess a stored name for.
    expect(
      await cli(
        "doc",
        "push",
        join(workdir, "second.md"),
        "--project",
        projectId,
        "--path",
        "docs/second.md",
      ),
    ).toBe(0);

    const all = JSON.parse(
      (await capture("doc", "ls", "--project", projectId, "--json")).stdout,
    );
    expect(all.items.length).toBeGreaterThanOrEqual(2);

    const first = JSON.parse(
      (
        await capture(
          "doc",
          "ls",
          "--project",
          projectId,
          "--limit",
          "1",
          "--json",
        )
      ).stdout,
    );
    const second = JSON.parse(
      (
        await capture(
          "doc",
          "ls",
          "--project",
          projectId,
          "--limit",
          "1",
          "--offset",
          "1",
          "--json",
        )
      ).stdout,
    );

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    // Both pages report the same full count, which is what makes the
    // "Showing N of M" line and its --limit/--offset advice honest.
    expect(first.total).toBe(all.total);
    expect(second.total).toBe(all.total);
    expect(first.truncated).toBe(true);
  });

  it("emits parseable JSON with --json", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cli("project", "ls", "--json")).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(() => JSON.parse(chunks.join(""))).not.toThrow();
  });

  it("lists an open finding and lets a human dismiss it", async () => {
    const findingId = await seedOpenFinding("src/ship.ts");

    const listed = await capture(
      "findings",
      "ls",
      "--project",
      projectId,
      "--status",
      "open",
    );
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(findingId);
    expect(listed.stdout).toContain("src/ship.ts:10-12");

    const resolved = await capture(
      "findings",
      "resolve",
      findingId,
      "--dismiss",
    );
    expect(resolved.code).toBe(0);

    const after = await capture(
      "findings",
      "ls",
      "--project",
      projectId,
      "--status",
      "dismissed",
      "--json",
    );
    expect(after.code).toBe(0);
    const page = JSON.parse(after.stdout) as {
      items: { id: string; status: string }[];
    };
    expect(page.items.find((f) => f.id === findingId)?.status).toBe(
      "dismissed",
    );

    // Answered once. The 409 is the whole reason there is no reopen flag.
    const again = await capture("findings", "resolve", findingId, "--accept");
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("not open");
  });

  it("refuses to let an agent close a question about its own edit", async () => {
    const findingId = await seedOpenFinding("src/agent.ts");
    const key = process.env["STANDFAST_API_KEY"];
    process.env["STANDFAST_API_KEY"] = agentKey;
    try {
      const res = await capture("findings", "resolve", findingId, "--dismiss");
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain("Only a human actor");
    } finally {
      process.env["STANDFAST_API_KEY"] = key;
    }
  });

  // Neither is an unanswered question and both is two opposite answers; either
  // way the CLI must not pick one.
  it("requires exactly one of --accept and --dismiss", async () => {
    expect(await cli("findings", "resolve", "some-id")).toBe(2);
    expect(
      await cli("findings", "resolve", "some-id", "--accept", "--dismiss"),
    ).toBe(2);
  });
  /**
   * A provisional atom: proposed, and not yet decided.
   *
   * Distinct from `seedOpenFinding`, which ratifies the atom it creates. A
   * canonical atom is no longer awaiting anything, so it never reaches the
   * queue — which is why the ratification tests cannot reuse that one.
   */
  async function seedProvisional(statement: string): Promise<string> {
    const docs = (await (
      await api(`/v1/projects/${projectId}/documents`, humanKey)
    ).json()) as { items: { id: string; path: string }[] };
    const docId = docs.items.find((d) => d.path === "docs/notes.md")?.id ?? "";
    const sections = (await (
      await api(`/v1/documents/${docId}/sections`, humanKey)
    ).json()) as { items: { id: string }[] };

    const created = await api(`/v1/projects/${projectId}/atoms`, humanKey, {
      method: "POST",
      body: JSON.stringify({
        documentId: docId,
        sectionId: sections.items[0]?.id ?? "",
        kind: "decision",
        statement,
        sourceQuote: "Always ship.",
        sourceSpan: { start: 7, end: 19 },
      }),
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  it("queue lists what is awaiting a decision", async () => {
    const id = await seedProvisional("Ship on Fridays.");

    const listed = await capture("queue", "--project", projectId);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(id);
    expect(listed.stdout).toContain("Ship on Fridays.");
    expect(listed.stdout).toContain("docs/notes.md");
  });

  // docs/15-ratification.md fixes the reading order and forbids collapsing the
  // section: the reviewer sees what surrounds the quote before the statement,
  // because a sentence that reads as a decision alone may be an example or a
  // rejected alternative in the paragraph that holds it.
  it("next shows the quote inside the whole section body", async () => {
    await seedProvisional("Ship on Saturdays.");

    const shown = await capture("next", "--project", projectId);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("docs/notes.md");
    // The section entire, not an ellipsis, with the quote marked in place.
    expect(shown.stdout).toContain("# Rule");
    expect(shown.stdout).toContain("\u00bbAlways ship.\u00ab");
  });

  /**
   * `docs/15-ratification.md`, Skip: moves the cursor, writes no status and no
   * event. The cursor is `--skip` riding the queue route's offset \u2014 client-side
   * and stateless \u2014 so the durable trace this test looks for is the absence of
   * one.
   */
  it("--skip shows the next atom over and writes nothing", async () => {
    await seedProvisional("Ship on Wednesdays.");
    await seedProvisional("Ship on Thursdays.");

    const listed = await capture("queue", "--project", projectId, "--json");
    expect(listed.code).toBe(0);
    const page = JSON.parse(listed.stdout) as {
      items: { id: string }[];
      total: number;
    };
    expect(page.total).toBeGreaterThanOrEqual(2);
    const headId = page.items[0]?.id ?? "";
    const secondId = page.items[1]?.id ?? "";

    const skipped = await capture(
      "next",
      "--project",
      projectId,
      "--skip",
      "1",
      "--json",
    );
    expect(skipped.code).toBe(0);
    expect((JSON.parse(skipped.stdout) as { id: string }).id).toBe(secondId);

    // The skipped-over head: still provisional, and its only event is still
    // the proposal. A skip that left either changed would be a decision.
    const probe = new Client({ connectionString: adminUrl });
    await probe.connect();
    try {
      const events = await probe.query(
        "select event from atom_events where atom_id = $1 order by at",
        [headId],
      );
      expect(events.rows.map((row) => row.event)).toEqual(["proposed"]);
      const status = await probe.query(
        "select status from atoms where id = $1",
        [headId],
      );
      expect(status.rows[0]?.status).toBe("provisional");
    } finally {
      await probe.end();
    }

    // A bare `next` forgets the skip, because there is nowhere to remember
    // it: the atom nobody decided is still the head.
    const again = await capture("next", "--project", projectId, "--json");
    expect((JSON.parse(again.stdout) as { id: string }).id).toBe(headId);

    // Past the end is a cursor pointing at nothing, not an empty queue.
    const past = await capture(
      "next",
      "--project",
      projectId,
      "--skip",
      "9999",
    );
    expect(past.code).toBe(0);
    expect(past.stdout).toContain("Skipped past the end");
    expect(past.stdout).toContain(`${page.total} awaiting ratification`);
  });

  /**
   * Reading-order item 6 (`docs/15-ratification.md`): the incumbent in full,
   * and the `--supersedes` hint offered only while one is on screen.
   */
  it("next shows the incumbent and offers --supersedes only then", async () => {
    const candidateId = await seedProvisional("Ship every Friday at noon.");
    const incumbentId = await seedProvisional("Deploys leave from main.");
    const done = await capture("ratify", incumbentId);
    expect(done.code).toBe(0);

    const probe = new Client({ connectionString: adminUrl });
    await probe.connect();
    try {
      // Unit vectors a chosen angle apart, written by the superuser because
      // the API \u2014 correctly \u2014 accepts no vectors. 0.9 is inside the judge
      // band, so the canonical atom is this candidate's incumbent.
      const unit = (cos: number) => {
        const v = new Array(1024).fill(0);
        v[0] = cos;
        v[1] = Math.sqrt(1 - cos * cos);
        return `[${v.join(",")}]`;
      };
      await probe.query("update atoms set embedding = $1 where id = $2", [
        unit(1),
        candidateId,
      ]);
      await probe.query("update atoms set embedding = $1 where id = $2", [
        unit(0.9),
        incumbentId,
      ]);

      const listed = await capture(
        "queue",
        "--project",
        projectId,
        "--limit",
        "50",
        "--json",
      );
      const page = JSON.parse(listed.stdout) as { items: { id: string }[] };
      const at = page.items.findIndex((item) => item.id === candidateId);
      expect(at).toBeGreaterThanOrEqual(0);

      const shown = await capture(
        "next",
        "--project",
        projectId,
        "--skip",
        String(at),
      );
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("INCUMBENT");
      expect(shown.stdout).toContain("similarity 0.90");
      // The statement whole, and the hint carrying the incumbent's id.
      expect(shown.stdout).toContain("Deploys leave from main.");
      expect(shown.stdout).toContain(`--supersedes ${incumbentId}`);

      // An atom with no embedding has no incumbent, and no hint offers what
      // is not on screen.
      const otherAt = page.items.findIndex((item) => item.id !== candidateId);
      expect(otherAt).toBeGreaterThanOrEqual(0);
      const other = await capture(
        "next",
        "--project",
        projectId,
        "--skip",
        String(otherAt),
      );
      expect(other.code).toBe(0);
      expect(other.stdout).not.toContain("INCUMBENT");
      expect(other.stdout).not.toContain("--supersedes");
    } finally {
      await probe.query(
        "update atoms set embedding = null where id = any($1::uuid[])",
        [[candidateId, incumbentId]],
      );
      await probe.end();
    }
  });

  it("ratify promotes one atom and takes it out of the queue", async () => {
    const id = await seedProvisional("Ship on Tuesdays.");

    const done = await capture("ratify", id);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("canonical");
    expect(done.stdout).toContain(id);

    const after = await capture("queue", "--project", projectId, "--json");
    const page = JSON.parse(after.stdout) as { items: { id: string }[] };
    expect(page.items.some((i) => i.id === id)).toBe(false);
  });

  it("reject --reason duplicate records the reason", async () => {
    const id = await seedProvisional("Ship on Wednesdays.");

    const done = await capture(
      "reject",
      id,
      "--reason",
      "duplicate",
      "--note",
      "the same rule as the Tuesday one",
    );
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("rejected");

    // The reason lives on the event, not the atom: rejecting is a thing that
    // happened, and the record of why is attached to when.
    const probe = new Client({ connectionString: adminUrl });
    await probe.connect();
    try {
      const stored = await probe.query<{
        reason: string | null;
        reason_note: string | null;
      }>(
        "select reason, reason_note from atom_events where atom_id = $1 and event = 'rejected'",
        [id],
      );
      expect(stored.rows[0]?.reason).toBe("duplicate");
      expect(stored.rows[0]?.reason_note).toBe(
        "the same rule as the Tuesday one",
      );
    } finally {
      await probe.end();
    }
  });

  it("refuses a reason outside the five before it reaches the server", async () => {
    const id = await seedProvisional("Ship on Sundays.");
    const res = await capture("reject", id, "--reason", "not_convinced");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--reason must be one of");
  });

  // No agent ratifies, rejects or retires anything. The database refuses it —
  // the composite foreign key — and the API supplies the sentence. The CLI
  // carries that sentence out rather than keeping a second copy of the rule.
  it("refuses an agent key with the server's own message", async () => {
    const id = await seedProvisional("Ship on Mondays.");
    const humanEnvKey = process.env["STANDFAST_API_KEY"];
    process.env["STANDFAST_API_KEY"] = agentKey;
    try {
      const refused = await capture("ratify", id);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("Only a human actor can ratify an atom");

      const rejected = await capture("reject", id, "--reason", "duplicate");
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("Only a human actor can reject");
    } finally {
      process.env["STANDFAST_API_KEY"] = humanEnvKey;
    }
  });

  // docs/02-principles.md (10) leaves the bar for this metric deliberately
  // unchosen. A default window would become that bar by accident, so omitting
  // the flag is a usage error rather than a number nobody picked.
  it("ratification without --older-than is a usage error", async () => {
    const res = await capture("ratification", "--project", projectId);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--older-than");
  });

  it("ratification takes a humane duration and reports the backlog", async () => {
    const res = await capture(
      "ratification",
      "--project",
      projectId,
      "--older-than",
      "7d",
      "--json",
    );
    expect(res.code).toBe(0);
    const metric = JSON.parse(res.stdout) as {
      backlog: number;
      decided: number;
      backlogOlderThan: number;
    };
    // Ratified and rejected above, so something has been decided, and the
    // atoms seeded and left alone are still waiting. The count for the window
    // is a subset of the backlog by definition; how large it is depends on the
    // clock, and asserting a number here would be inventing one.
    expect(metric.decided).toBeGreaterThan(0);
    expect(metric.backlog).toBeGreaterThan(0);
    expect(metric.backlogOlderThan).toBeLessThanOrEqual(metric.backlog);
  });

  it("refuses a duration it cannot read", async () => {
    const res = await capture(
      "ratification",
      "--project",
      projectId,
      "--older-than",
      "soon",
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--older-than");
  });
});

/**
 * The export contract, `docs/11-git-export.md` (*How this is checked*): the
 * six statements a machine can check, run against the real API. The unit half
 * — path refusals, atom ordering, the ownership sentinel — lives in
 * packages/cli; what is proven here is the tree on disk.
 */
describe("standfast export end to end", () => {
  const suffix = `${Date.now()}-${process.pid}`;
  const slug = `exp-${suffix}`;
  const rtSlug = `rt-${suffix}`;
  let target = "";
  let pid = "";
  let guideDocId = "";
  let nestedDocId = "";
  let rtId = "";

  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  /** Every file under `dir`, keyed by relative path. */
  async function tree(dir: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const entry of await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        const full = join(entry.parentPath, entry.name);
        found.set(relative(dir, full), await readFile(full, "utf8"));
      }
    }
    return found;
  }

  async function projectIdOf(wanted: string): Promise<string> {
    const res = (await (
      await api("/v1/projects?limit=200", humanKey)
    ).json()) as { items: { id: string; slug: string }[] };
    return res.items.find((p) => p.slug === wanted)?.id ?? "";
  }

  async function createAtom(
    documentId: string,
    sectionId: string,
    statement: string,
    quote: string,
    span: { start: number; end: number },
  ): Promise<string> {
    const created = await api(`/v1/projects/${pid}/atoms`, humanKey, {
      method: "POST",
      body: JSON.stringify({
        documentId,
        sectionId,
        statement,
        kind: "decision",
        sourceQuote: quote,
        sourceSpan: span,
      }),
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { id: string }).id;
  }

  async function ratifyAtom(id: string, supersedes?: string): Promise<void> {
    const query = supersedes ? `?supersedes=${supersedes}` : "";
    const res = await api(`/v1/atoms/${id}/ratify${query}`, humanKey, {
      method: "POST",
    });
    expect(res.status).toBe(200);
  }

  beforeAll(async () => {
    target = join(workdir, "sf-export");
    expect(await cli("project", "create", "Export E2E", "--slug", slug)).toBe(
      0,
    );
    pid = await projectIdOf(slug);
    expect(pid).not.toBe("");

    const guide = join(workdir, "guide.md");
    await writeFile(guide, "# Rule\nAlways ship.\n\n# Second\nMore.", "utf8");
    expect(
      await cli(
        "doc",
        "push",
        guide,
        "--project",
        pid,
        "--path",
        "docs/guide.md",
      ),
    ).toBe(0);
    const nested = join(workdir, "nested-notes.md");
    await writeFile(nested, "# Notes\nKeep notes.", "utf8");
    expect(
      await cli(
        "doc",
        "push",
        nested,
        "--project",
        pid,
        "--path",
        "docs/nested/notes.md",
      ),
    ).toBe(0);

    const docs = (await (
      await api(`/v1/projects/${pid}/documents`, humanKey)
    ).json()) as { items: { id: string; path: string }[] };
    guideDocId = docs.items.find((d) => d.path === "docs/guide.md")?.id ?? "";
    nestedDocId =
      docs.items.find((d) => d.path === "docs/nested/notes.md")?.id ?? "";

    const sections = (await (
      await api(`/v1/documents/${guideDocId}/sections`, humanKey)
    ).json()) as { items: { id: string; body: string }[] };
    const rule = sections.items.find((s) => s.body.includes("Always ship."));
    const sectionId = rule?.id ?? "";
    const start = rule?.body.indexOf("Always ship.") ?? 0;
    const span = { start, end: start + "Always ship.".length };

    // One atom per status, all in one section, so the projection carries the
    // whole vocabulary and the superseded one has active siblings to sort
    // under.
    const oldOne = await createAtom(
      guideDocId,
      sectionId,
      "Ship (superseded).",
      "Always ship.",
      span,
    );
    await ratifyAtom(oldOne);
    const newOne = await createAtom(
      guideDocId,
      sectionId,
      "Ship (canonical).",
      "Always ship.",
      span,
    );
    await ratifyAtom(newOne, oldOne);
    await createAtom(
      guideDocId,
      sectionId,
      "Ship (provisional).",
      "Always ship.",
      span,
    );
    const rejected = await createAtom(
      guideDocId,
      sectionId,
      "Ship (rejected).",
      "Always ship.",
      span,
    );
    const refusal = await api(`/v1/atoms/${rejected}/reject`, humanKey, {
      method: "POST",
      body: JSON.stringify({ reason: "duplicate" }),
    });
    expect(refusal.status).toBe(200);
    const retired = await createAtom(
      guideDocId,
      sectionId,
      "Ship (retired).",
      "Always ship.",
      span,
    );
    await ratifyAtom(retired);
    const gone = await api(`/v1/atoms/${retired}/retire`, humanKey, {
      method: "POST",
    });
    expect(gone.status).toBe(200);

    const nestedSections = (await (
      await api(`/v1/documents/${nestedDocId}/sections`, humanKey)
    ).json()) as { items: { id: string; body: string }[] };
    const notes = nestedSections.items[0];
    const nStart = notes?.body.indexOf("Keep notes.") ?? 0;
    const nestedAtom = await createAtom(
      nestedDocId,
      notes?.id ?? "",
      "Keep notes.",
      "Keep notes.",
      { start: nStart, end: nStart + "Keep notes.".length },
    );
    await ratifyAtom(nestedAtom);
  });

  // Check 1: idempotence is a gate, not an aspiration.
  it("exports twice and the trees are byte-identical", async () => {
    const first = await capture("export", target, "--json");
    expect(first.code).toBe(0);
    const report = JSON.parse(first.stdout) as {
      swept: string[];
      exportedAt: string;
      written: number;
    };
    // The run report may carry a timestamp; the tracked files may not.
    expect(report.swept).toEqual([]);
    expect(report.exportedAt).toMatch(/^\d{4}-/);
    const before = await tree(target);
    expect(before.size).toBeGreaterThan(0);

    const second = await capture("export", target, "--json");
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as { swept: string[] }).swept).toEqual(
      [],
    );
    const after = await tree(target);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, body] of before) {
      expect(after.get(path)).toBe(body);
    }
  });

  // Check 2: the verbatim-body rule, enforced — sha256 of any exported file
  // reproduces content_hash in the manifest, with an OS-supplied tool.
  it("every exported document hashes to its manifest content_hash", async () => {
    const manifest = JSON.parse(
      await readFile(join(target, "standfast.json"), "utf8"),
    ) as {
      standfast: string;
      projects: {
        slug: string;
        documents: { path: string; content_hash: string }[];
      }[];
    };
    expect(manifest.standfast).toBe("export/v1");
    expect(
      manifest.projects.find((p) => p.slug === slug)?.documents,
    ).toHaveLength(2);

    let checked = 0;
    for (const project of manifest.projects) {
      for (const doc of project.documents) {
        const body = await readFile(
          join(target, project.slug, doc.path),
          "utf8",
        );
        expect(sha256(body)).toBe(doc.content_hash);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  // Check 3: every atom appears exactly once, in exactly one projection file,
  // and its blockquote is the code-point slice of the section body at the
  // recorded span — written with the en dash the format fixes.
  it("projects every atom exactly once, quote matching span", async () => {
    const atoms = (await (
      await api(`/v1/projects/${pid}/atoms?limit=200`, humanKey)
    ).json()) as {
      items: {
        id: string;
        status: string;
        sectionId: string;
        supersededBy: string | null;
        sourceSpan: { start: number; end: number };
      }[];
    };
    // All five statuses export; the record keeps its history.
    expect(new Set(atoms.items.map((a) => a.status))).toEqual(
      new Set([
        "provisional",
        "canonical",
        "rejected",
        "superseded",
        "retired",
      ]),
    );

    const projections = await tree(join(target, slug, ".standfast"));
    const guideProjection = projections.get("atoms/docs/guide.md") ?? "";
    expect(guideProjection.startsWith("---\nstandfast: atoms/v1\n")).toBe(true);
    expect(guideProjection).toContain("## Rule");
    expect(guideProjection).toMatch(/section \d+ · [0-9a-f]{8}…/);

    const bodies = [...projections.values()];
    for (const atom of atoms.items) {
      const heading = `### ${atom.id.slice(0, 8)}`;
      const holders = bodies.filter((b) => b.includes(heading));
      expect(holders).toHaveLength(1);
      expect((holders[0] ?? "").split(heading)).toHaveLength(2);

      const block =
        (holders[0] ?? "").split(heading)[1]?.split(/\n#{2,3} /)[0] ?? "";
      expect(block).toContain(
        `- span: ${atom.sourceSpan.start}–${atom.sourceSpan.end}`,
      );
      if (atom.supersededBy !== null) {
        expect(block).toContain(
          `- superseded_by: ${atom.supersededBy.slice(0, 8)}`,
        );
      }

      const section = (await (
        await api(`/v1/sections/${atom.sectionId}`, humanKey)
      ).json()) as { body: string };
      const sliced = [...section.body]
        .slice(atom.sourceSpan.start, atom.sourceSpan.end)
        .join("");
      const quoted = block
        .split("\n")
        .filter((line) => line.startsWith(">"))
        .map((line) => (line === ">" ? "" : line.slice(2)))
        .join("\n");
      expect(quoted).toBe(sliced);
    }
  });

  // Check 6: push the exported bodies back and the content-hash set comes out
  // identical — a round-trip that needs no translation step.
  it("round-trips the exported documents into a fresh project", async () => {
    expect(await cli("project", "create", "Round Trip", "--slug", rtSlug)).toBe(
      0,
    );
    rtId = await projectIdOf(rtSlug);
    expect(rtId).not.toBe("");

    const manifest = JSON.parse(
      await readFile(join(target, "standfast.json"), "utf8"),
    ) as {
      projects: {
        slug: string;
        documents: { path: string; content_hash: string }[];
      }[];
    };
    const mine = manifest.projects.find((p) => p.slug === slug);
    for (const doc of mine?.documents ?? []) {
      expect(
        await cli(
          "doc",
          "push",
          join(target, slug, doc.path),
          "--project",
          rtId,
          "--path",
          doc.path,
        ),
      ).toBe(0);
    }

    const pushed = (await (
      await api(`/v1/projects/${rtId}/documents`, humanKey)
    ).json()) as { items: { contentHash: string }[] };
    expect(new Set(pushed.items.map((d) => d.contentHash))).toEqual(
      new Set((mine?.documents ?? []).map((d) => d.content_hash)),
    );
  });

  // Check 4: deletion is part of export — a document removed on the server
  // disappears from the tree, and its projection goes with it.
  it("sweeps a document the server no longer has", async () => {
    const del = await api(`/v1/documents/${nestedDocId}`, humanKey, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);

    const res = await capture("export", target, "--json");
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout) as { swept: string[] };
    expect(report.swept).toContain(`${slug}/docs/nested/notes.md`);
    expect(report.swept).toContain(
      `${slug}/.standfast/atoms/docs/nested/notes.md`,
    );
    await expect(
      stat(join(target, slug, "docs/nested/notes.md")),
    ).rejects.toThrow();
    // The directory the deletion emptied is pruned too.
    await expect(stat(join(target, slug, "docs/nested"))).rejects.toThrow();

    const manifest = JSON.parse(
      await readFile(join(target, "standfast.json"), "utf8"),
    ) as { projects: { slug: string; documents: { path: string }[] }[] };
    expect(
      manifest.projects
        .find((p) => p.slug === slug)
        ?.documents.map((d) => d.path),
    ).toEqual(["docs/guide.md"]);
  });

  // The other half of deletion: a project directory the previous manifest
  // lists but the server no longer returns is removed whole.
  it("sweeps a project directory the server no longer has", async () => {
    const del = await api(`/v1/projects/${rtId}`, humanKey, {
      method: "DELETE",
    });
    expect([200, 204]).toContain(del.status);

    const res = await capture("export", target, "--json");
    expect(res.code).toBe(0);
    expect((JSON.parse(res.stdout) as { swept: string[] }).swept).toContain(
      `${rtSlug}/`,
    );
    await expect(stat(join(target, rtSlug))).rejects.toThrow();
  });

  // Check 5: a server response naming a path outside the tree is refused, not
  // written — a server should not choose where a client writes.
  it("refuses an escaping document path and writes nothing", async () => {
    const evilSlug = `evil-${suffix}`;
    expect(await cli("project", "create", "Evil", "--slug", evilSlug)).toBe(0);
    const evilId = await projectIdOf(evilSlug);
    const put = await api(`/v1/projects/${evilId}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({ path: "../escape.md", body: "# Out\nNo." }),
    });
    expect(put.status).toBe(200);
    const evilDocId = ((await put.json()) as { id: string }).id;

    const fresh = join(workdir, "sf-refused");
    const res = await capture("export", fresh);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("outside the export directory");
    // Nothing was written: the tree is built in memory before the first
    // write, so a refusal leaves no partial export behind.
    await expect(stat(fresh)).rejects.toThrow();
    await expect(stat(join(workdir, "escape.md"))).rejects.toThrow();

    expect(
      (await api(`/v1/documents/${evilDocId}`, humanKey, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("refuses a document stored under the reserved .standfast/", async () => {
    const evilId = await projectIdOf(`evil-${suffix}`);
    const put = await api(`/v1/projects/${evilId}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({ path: ".standfast/atoms/x.md", body: "# X\nNo." }),
    });
    expect(put.status).toBe(200);
    const evilDocId = ((await put.json()) as { id: string }).id;

    const fresh = join(workdir, "sf-reserved");
    const res = await capture("export", fresh);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(".standfast/ is reserved");
    await expect(stat(fresh)).rejects.toThrow();

    expect(
      (await api(`/v1/documents/${evilDocId}`, humanKey, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  // The destructive half is fenced: a non-empty directory without a manifest
  // is somebody's directory, and export refuses to own it.
  it("refuses a non-empty target it did not write", async () => {
    const foreign = join(workdir, "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "precious.txt"), "mine", "utf8");

    const res = await capture("export", foreign);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("standfast.json");
    expect(await readFile(join(foreign, "precious.txt"), "utf8")).toBe("mine");
  });
});

/**
 * `standfast sync`, `docs/10-sync-daemon.md` end to end: the blast-radius
 * guard, the observable rows of the conflict table, and the explicit deletion
 * path. The planner's rows are unit tests in packages/cli; what is proven
 * here is the wire — what reached the server, and what never did.
 */
describe("standfast sync end to end", () => {
  const suffix = `${Date.now()}-${process.pid}`;
  const slug = `sync-${suffix}`;
  let root = "";
  let pid = "";

  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  const manifest = async () =>
    (await (
      await api(`/v1/projects/${pid}/documents/manifest?limit=200`, humanKey)
    ).json()) as {
      items: { id: string; path: string; contentHash: string }[];
      total: number;
    };

  const docIdOf = async (path: string) =>
    (await manifest()).items.find((d) => d.path === path)?.id ?? "";

  const bodyOf = async (path: string) => {
    const res = await api(`/v1/documents/${await docIdOf(path)}`, humanKey);
    return ((await res.json()) as { body: string }).body;
  };

  beforeAll(async () => {
    expect(await cli("project", "create", "Sync E2E", "--slug", slug)).toBe(0);
    const projects = (await (
      await api("/v1/projects?limit=200", humanKey)
    ).json()) as { items: { id: string; slug: string }[] };
    pid = projects.items.find((p) => p.slug === slug)?.id ?? "";
    expect(pid).not.toBe("");

    root = join(workdir, "sync-root");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "standfast.sync.json"),
      JSON.stringify({ project: slug, include: ["docs/**/*.md"] }),
      "utf8",
    );
    await writeFile(join(root, "docs", "a.md"), "# A\nAlpha.", "utf8");
    await writeFile(join(root, "docs", "b.md"), "# B\nBeta.", "utf8");
    // Unmatched: must never reach the server.
    await writeFile(join(root, "secret.md"), "PRIVATE", "utf8");
  });

  it("refuses the first run, uploads nothing, and names --accept", async () => {
    const res = await capture("sync", root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("standfast sync --accept");
    expect((await manifest()).total).toBe(0);
  });

  it("--accept records the scope and uploads exactly the matched set", async () => {
    expect(await cli("sync", root, "--accept")).toBe(0);
    const m = await manifest();
    expect(m.items.map((d) => d.path).sort()).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    // The stored hash is the content's own sha256, verifiable offline.
    expect(m.items.find((d) => d.path === "docs/a.md")?.contentHash).toBe(
      sha256("# A\nAlpha."),
    );
    // A second run needs no flag and changes nothing.
    expect(await cli("sync", root)).toBe(0);
  });

  it("pushes an edited file on the next run", async () => {
    await writeFile(join(root, "docs", "a.md"), "# A\nAlpha, revised.", "utf8");
    expect(await cli("sync", root)).toBe(0);
    expect(
      (await manifest()).items.find((d) => d.path === "docs/a.md")?.contentHash,
    ).toBe(sha256("# A\nAlpha, revised."));
  });

  // The digest covers the resolved path list, so a new file arriving under an
  // existing glob re-arms the plan rather than inheriting yesterday's consent.
  it("a new matched file re-arms the plan", async () => {
    await writeFile(join(root, "docs", "c.md"), "# C\nGamma.", "utf8");
    expect(await cli("sync", root)).toBe(1);
    expect((await manifest()).items.map((d) => d.path)).not.toContain(
      "docs/c.md",
    );
    expect(await cli("sync", root, "--accept")).toBe(0);
    expect((await manifest()).items.map((d) => d.path)).toContain("docs/c.md");
  });

  it("re-bases and exits 0 when only the server moved", async () => {
    const put = await api(`/v1/projects/${pid}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({
        path: "docs/b.md",
        body: "# B\nBeta, from a colleague.",
      }),
    });
    expect(put.status).toBe(200);

    expect(await cli("sync", root)).toBe(0);
    // Nothing was uploaded — the server's body stands — and the journal now
    // carries the server's hash as the base, so the next run is a no-op.
    expect(await bodyOf("docs/b.md")).toBe("# B\nBeta, from a colleague.");
    expect(await cli("sync", root)).toBe(0);
  });

  it("exits 1 on a both-sides conflict and uploads neither side", async () => {
    await writeFile(join(root, "docs", "a.md"), "# A\nAlpha, local.", "utf8");
    const put = await api(`/v1/projects/${pid}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({ path: "docs/a.md", body: "# A\nAlpha, remote." }),
    });
    expect(put.status).toBe(200);

    const res = await capture("sync", root);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("CONFLICT");
    expect(await bodyOf("docs/a.md")).toBe("# A\nAlpha, remote.");
  });

  it("resolve --take-local pushes the chosen side and clears the conflict", async () => {
    expect(
      await cli("sync", "resolve", "docs/a.md", "--take-local", root),
    ).toBe(0);
    expect(await bodyOf("docs/a.md")).toBe("# A\nAlpha, local.");
    expect(await cli("sync", root)).toBe(0);
  });

  it("exits 1 when the server is unreachable, uploading nothing", async () => {
    const dead = (() =>
      Promise.reject(
        new Error("ECONNREFUSED"),
      )) as unknown as typeof globalThis.fetch;
    expect(await run(["sync", root], { fetch: dead })).toBe(1);
  });

  it("doc rm is the explicit deletion path", async () => {
    const id = await docIdOf("docs/c.md");
    expect(id).not.toBe("");
    expect(await cli("doc", "rm", id)).toBe(0);
    expect((await api(`/v1/documents/${id}`, humanKey)).status).toBe(404);
  });
});

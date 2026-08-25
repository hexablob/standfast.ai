import { type SQL, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import { pageOf } from "../pagination.js";
import { createAtom, ratifyAtom } from "../repositories/atoms.js";
import {
  countDrift,
  listFindings,
  recordReconciliation,
  resolveFinding,
} from "../repositories/reconciliation.js";
import {
  adminUrl,
  appClient,
  asOrg,
  ensureTestRole,
  QUOTE_A,
  SECTION_A_BODY,
  type Seed,
  seed,
} from "./harness.js";

/**
 * Phase 3 — the reconciliation tables, and what they refuse.
 *
 * `docs/07-reconciliation.md` puts four rules in the schema rather than in
 * whichever route happens to write the row: a violation cites a line, exactly
 * the violations sit in a human's queue, a resolver is a human, and a file path
 * is a pointer into a tree this server has never seen. Most of what follows
 * attempts one of those and watches the database refuse it, because a
 * constraint nobody has seen fail is a comment.
 *
 * Everything runs through the unprivileged role, the way production reaches the
 * database. As the superuser the grant tests would pass while proving nothing,
 * and RLS would not apply to a single row read here.
 */

let app: Client;
let data: Seed;
const originalUrl = process.env["DATABASE_URL"];

/**
 * A committed run and atom for the raw inserts below to point at.
 *
 * A finding needs both to exist, so without them a fixture that violates one
 * check would fail on a dangling foreign key instead — refused for the right
 * outcome and the wrong reason, which is the failure mode these tests exist to
 * catch elsewhere.
 */
let runId = "";
let anchorAtom = "";

/** A ratified atom in the next project over, and one in the next org over. */
let nextProject: Elsewhere;
let nextOrg: Elsewhere;

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();

  app = await appClient();

  nextProject = await elsewhere(data.orgA, "next-project");
  nextOrg = await elsewhere(data.orgB, "next-org");

  anchorAtom = await provisionalAtom();
  const bootstrap = await withActor(data.orgA, data.agentA, (db) =>
    recordReconciliation(db, {
      orgId: data.orgA,
      projectId: data.projectA,
      actorId: data.agentA,
      trigger: "explicit",
      items: [
        { atomId: anchorAtom, verdict: "honored", filePath: "src/anchor.ts" },
      ],
    }),
  );
  runId = bootstrap.runId;
});

afterAll(async () => {
  await app?.end();
  await closePool();
  if (originalUrl) {
    process.env["DATABASE_URL"] = originalUrl;
  }
});

/**
 * A provisional atom on the seeded section.
 *
 * The span is read off `SECTION_A_BODY` rather than counted by hand: the insert
 * trigger compares quote and span against the stored body, so a hand-counted
 * offset would fail as loudly as a real defect and mean nothing.
 */
async function provisionalAtom(): Promise<string> {
  const start = SECTION_A_BODY.indexOf(QUOTE_A);
  return withActor(data.orgA, data.humanA, async (db) => {
    const atom = await createAtom(db, data.orgA, data.humanA, {
      projectId: data.projectA,
      documentId: data.documentA,
      sectionId: data.sectionA,
      statement: QUOTE_A,
      kind: "convention",
      sourceQuote: QUOTE_A,
      sourceSpan: { start, end: start + QUOTE_A.length },
    });
    return atom.id;
  });
}

/**
 * A superuser connection.
 *
 * `adminClient` reads `DATABASE_URL`, which this file repoints at the
 * unprivileged role for the duration of the suite, so the owner's URL is taken
 * from the value captured before the swap. Only fixtures that have to exist on
 * the far side of a boundary — another project, another org — need it.
 */
async function owner(): Promise<Client> {
  const client = new Client({ connectionString: originalUrl ?? "" });
  await client.connect();
  return client;
}

type Elsewhere = { project: string; atom: string; run: string };

/**
 * A project, a document, a section and one canonical atom, in whichever org is
 * asked for.
 *
 * Referential integrity runs with `row_security = off`, so until the key on
 * `(atom_id, project_id)` an atom id from the next project — or the next org —
 * was exactly as usable as a local one, and RLS never saw the reference at all.
 * The fixture has to be a real ratified atom for that reason: an invented uuid
 * would be refused for being absent and would prove nothing about the boundary.
 * Body 't', quote 't', span '[0,1)' is the smallest text the atom trigger takes.
 */
async function elsewhere(orgId: string, slug: string): Promise<Elsewhere> {
  const db = await owner();
  try {
    const one = async (statement: string, values: unknown[]): Promise<string> =>
      (await db.query<{ id: string }>(statement, values)).rows[0]?.id ?? "";

    const project = await one(
      "insert into projects (org_id, name, slug) values ($1, $2, $2) returning id",
      [orgId, slug],
    );
    const document = await one(
      `insert into documents (org_id, project_id, path, body, content_hash)
       values ($1, $2, 'docs/e.md', 't', 'h-e') returning id`,
      [orgId, project],
    );
    const section = await one(
      `insert into document_sections
         (org_id, document_id, ordinal, heading_path, body, section_hash)
       values ($1, $2, 0, ARRAY['t'], 't', 'h-e') returning id`,
      [orgId, document],
    );
    const human = await one(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', 'e') returning id",
      [orgId],
    );
    const atom = await one(
      `insert into atoms
         (org_id, project_id, document_id, section_id, statement, kind, status,
          ratified_by, ratified_by_kind, ratified_at, source_quote, source_span)
       values ($1, $2, $3, $4, 's', 'decision', 'canonical', $5, 'human', now(), 't', '[0,1)')
       returning id`,
      [orgId, project, document, section, human],
    );
    const run = await one(
      `insert into reconciliation_runs
         (org_id, project_id, actor_id, trigger, verdict_count)
       values ($1, $2, $3, 'explicit', 0) returning id`,
      [orgId, project, human],
    );
    return { project, atom, run };
  } finally {
    await db.end();
  }
}

type FindingRow = {
  verdict: string;
  status: string;
  atomId?: string;
  projectId?: string;
  runId?: string;
  filePath?: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  rationale?: string | null;
  resolvedBy?: string | null;
  resolvedByKind?: string | null;
  resolvedAt?: Date | null;
};

/**
 * One raw finding insert, inside a transaction that is rolled back.
 *
 * Raw SQL rather than `recordReconciliation`, because the repository is written
 * to satisfy every check below — asking it to produce a violating row would be
 * testing a code path that does not exist. `asOrg` rolls back, so the rows the
 * database *accepts* leave nothing behind for the next test to count.
 */
function insertFinding(row: FindingRow): Promise<{ rowCount: number | null }> {
  return asOrg(app, data.orgA, () =>
    app.query(
      `insert into reconciliation_findings
         (org_id, project_id, run_id, atom_id, verdict, file_path,
          line_start, line_end, rationale, status,
          resolved_by, resolved_by_kind, resolved_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        data.orgA,
        row.projectId ?? data.projectA,
        row.runId ?? runId,
        row.atomId ?? anchorAtom,
        row.verdict,
        row.filePath ?? "src/a.ts",
        row.lineStart ?? null,
        row.lineEnd ?? null,
        row.rationale ?? null,
        row.status,
        row.resolvedBy ?? null,
        row.resolvedByKind ?? null,
        row.resolvedAt ?? null,
      ],
    ),
  );
}

/**
 * Runs a write that must be refused and returns what the database said.
 *
 * Drizzle wraps a driver error in one whose message is the SQL it sent and
 * hangs the database's own message off `cause`. Matching the wrapper would pass
 * for any failure at all — a typo in the fixture included — so the assertion
 * has to reach the cause.
 */
async function refusal(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error("expected the write to be refused, and it was not");
}

describe("a finding the schema refuses", () => {
  // Principle 8 as a constraint. A violation nobody can navigate to is an
  // accusation without evidence, and the first one a reviewer dismisses.
  it("a violation with no line to cite", async () => {
    await expect(
      insertFinding({ verdict: "violated", status: "open" }),
    ).rejects.toThrow(/reconciliation_findings_violation_cites_lines/);
  });

  // The biconditional, from both sides. Either direction alone would leave the
  // queue as whatever the writer of the day remembered to set.
  it("a non-violation filed into the human queue", async () => {
    await expect(
      insertFinding({ verdict: "honored", status: "open" }),
    ).rejects.toThrow(/reconciliation_findings_queue_biconditional/);
  });

  it("a violation filed outside the human queue", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "recorded",
        lineStart: 10,
        lineEnd: 12,
      }),
    ).rejects.toThrow(/reconciliation_findings_queue_biconditional/);
  });

  it("a span that ends before it starts", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "open",
        lineStart: 10,
        lineEnd: 9,
      }),
    ).rejects.toThrow(/reconciliation_findings_line_end_ordered/);
  });

  // Files are numbered from one. A zero here is an off-by-one in the agent, and
  // the cheapest place to find it is the insert.
  it("a line number of zero", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "open",
        lineStart: 0,
        lineEnd: 5,
      }),
    ).rejects.toThrow(/reconciliation_findings_line_start_positive/);
  });

  // 280 characters holds a sentence and not a function. The cap is the known
  // hole in the third invariant kept small, not closed.
  it("a rationale one character over the cap", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        rationale: "x".repeat(281),
      }),
    ).rejects.toThrow(/reconciliation_findings_rationale_capped/);
  });

  it("an absolute file path", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        filePath: "/abs/x.ts",
      }),
    ).rejects.toThrow(/reconciliation_findings_file_path_is_a_pointer/);
  });

  it("a file path that climbs out of the tree", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        filePath: "a/../b",
      }),
    ).rejects.toThrow(/reconciliation_findings_file_path_is_a_pointer/);
  });

  /**
   * Regression, and the one place the asymmetry with `rationale` is written
   * down. A rationale is capped and never served back out; `file_path` is 1024
   * characters and *is* echoed by the API. With only the shape rules on it,
   * "src/a.ts\nfunction secret() { ... }" was a legal path — a second free-text
   * field, four times the size of the hole we admit to, carrying none of its
   * controls. A path never contains a control character, so refusing the whole
   * class costs nothing and closes it. `isSubmittableFilePath` applies the same
   * rule at the API, for the reason the rationale's single-line rule lives
   * there: only the boundary can hand a caller back a reason.
   */
  it("a file path with a newline in it", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        filePath: "src/a.ts\nfunction secret() {}",
      }),
    ).rejects.toThrow(/reconciliation_findings_file_path_is_a_pointer/);
  });

  it("a file path with a tab in it", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        filePath: "src/a.ts\tsrc/b.ts",
      }),
    ).rejects.toThrow(/reconciliation_findings_file_path_is_a_pointer/);
  });

  it("a file path with a carriage return in it", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        filePath: "src/a.ts\rsrc/b.ts",
      }),
    ).rejects.toThrow(/reconciliation_findings_file_path_is_a_pointer/);
  });

  /**
   * Regression. The key was on `atoms (id)` alone, and referential integrity
   * runs with `row_security = off` — so an atom id from another project
   * satisfied it without RLS ever being consulted. `countDrift` counts findings
   * by `atom_id`, which made this a way to mark someone else's atom as checked
   * by filing a verdict in your own project. The key is now on
   * `(atom_id, project_id)`, so the two columns have to agree.
   */
  it("an atom belonging to another project", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        atomId: nextProject.atom,
      }),
    ).rejects.toThrow(/reconciliation_findings_atom_in_project_fk/);
  });

  // Same key, and the case it really exists for: the atom is in another org
  // entirely, which the single-column version could not see either.
  it("an atom belonging to another org", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        atomId: nextOrg.atom,
      }),
    ).rejects.toThrow(/reconciliation_findings_atom_in_project_fk/);
  });

  // The composite key to `actors (id, kind)`, doing the same job it does for
  // ratification: a row naming an agent's id has to claim `agent` to satisfy
  // the key, and `resolver_is_human` refuses that — so claiming `human` for an
  // agent fails the key instead. An agent dismissing a finding about its own
  // edit is the reconciliation-shaped version of promoting its own knowledge,
  // and it fails in the database rather than in whichever route remembered.
  it("an agent as the resolver", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "dismissed",
        lineStart: 1,
        lineEnd: 2,
        resolvedBy: data.agentA,
        resolvedByKind: "human",
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow(/reconciliation_findings_resolver_fk/);
  });

  /**
   * Regression, and the reason `resolution_complete` names all three columns.
   *
   * A NULL `resolved_by_kind` used to switch off both guards on the resolver at
   * once. `CHECK (resolved_by_kind = 'human')` evaluates to NULL against a NULL
   * and a check passes on NULL; the key to `actors (id, kind)` is MATCH SIMPLE,
   * so Postgres skips it outright when any referencing column is NULL. Leave
   * the kind out and an agent could be written in as the resolver of a
   * violation against its own edit — "only a human resolves a finding" survived
   * as a line of application code and nothing else. Requiring the kind is what
   * puts both guards back in the path.
   */
  it("a resolution that omits the resolver's kind, accepting", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "accepted",
        lineStart: 1,
        lineEnd: 2,
        resolvedBy: data.agentA,
        resolvedByKind: null,
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow(/reconciliation_findings_resolution_complete/);
  });

  it("a resolution that omits the resolver's kind, dismissing", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "dismissed",
        lineStart: 1,
        lineEnd: 2,
        resolvedBy: data.agentA,
        resolvedByKind: null,
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow(/reconciliation_findings_resolution_complete/);
  });

  // A half-stamped resolution reads as answered in the queue and as unanswered
  // in the audit trail. The kill metric is counted off these rows.
  it("a resolution with no timestamp", async () => {
    await expect(
      insertFinding({
        verdict: "violated",
        status: "dismissed",
        lineStart: 1,
        lineEnd: 2,
        resolvedBy: data.humanA,
        resolvedByKind: "human",
        resolvedAt: null,
      }),
    ).rejects.toThrow(/reconciliation_findings_resolution_complete/);
  });
});

describe("a finding the schema accepts", () => {
  /**
   * The split is deliberate, and this test is where it is written down.
   *
   * The database caps the rationale's length and nothing else. The single-line
   * rule is `isSubmittableRationale` in `packages/core/src/reconcile.ts`,
   * enforced by the Zod request schema — so a pasted snippet is refused at the
   * API, at the trust boundary, where a refusal can carry a reason back to the
   * caller. Duplicating it as a check constraint would put the same rule in two
   * places and let them drift; leaving the cap out of the schema would let a
   * direct writer past it. Each control lives once, at the layer that can act
   * on it.
   */
  it("a rationale containing a newline, which only the API refuses", async () => {
    const accepted = await insertFinding({
      verdict: "honored",
      status: "recorded",
      rationale: "first line\nsecond line",
    });
    expect(accepted.rowCount).toBe(1);
  });

  /**
   * Regression. The path check was `(^|/)..(/|$)` with the dots unescaped, so
   * `.` matched any character and every two-character directory name — `db`,
   * `ui`, `io` — read as a traversal attempt. The constraint refused most of
   * this repository's own source tree while looking exactly like a correct one.
   */
  it("a path with a two-character directory in it", async () => {
    const accepted = await insertFinding({
      verdict: "honored",
      status: "recorded",
      filePath: "src/db/x.ts",
    });
    expect(accepted.rowCount).toBe(1);
  });

  // The other half of the resolver regression: tightening `resolution_complete`
  // has to leave the shape a human resolution actually takes, or the constraint
  // would have been fixed by making the feature unreachable.
  it("a resolution naming a human, their kind and the moment", async () => {
    const accepted = await insertFinding({
      verdict: "violated",
      status: "accepted",
      lineStart: 1,
      lineEnd: 2,
      resolvedBy: data.humanA,
      resolvedByKind: "human",
      resolvedAt: new Date(),
    });
    expect(accepted.rowCount).toBe(1);
  });
});

describe("an atom takes its findings with it", () => {
  // The composite key replaced the single-column one, so the cascade had to be
  // rewritten too — and a cascade that quietly stopped cascading would leave
  // findings pointing at a statement that no longer exists, which is the one
  // way a finding can outlive the thing it is a finding about.
  it("deleting an atom deletes the findings recorded against it", async () => {
    const atomId = await provisionalAtom();
    await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "explicit",
        items: [{ atomId, verdict: "honored", filePath: "src/doomed.ts" }],
      }),
    );

    const db = await owner();
    try {
      const before = await db.query(
        "select id from reconciliation_findings where atom_id = $1",
        [atomId],
      );
      expect(before.rowCount).toBe(1);

      // As the superuser: `standfast_app` has no DELETE on either table, which
      // is the point of the grants, and the cascade is the server's own.
      await db.query("delete from atoms where id = $1", [atomId]);

      const after = await db.query(
        "select id from reconciliation_findings where atom_id = $1",
        [atomId],
      );
      expect(after.rowCount).toBe(0);
    } finally {
      await db.end();
    }
  });
});

describe("a reconciliation row names one tenant, in every column", () => {
  /**
   * Regression, and the reason row-level security was never going to cover it.
   *
   * A policy compares the row's `org_id` against the session GUC and stops
   * there. It has no opinion on whether the row's other foreign keys agree with
   * that `org_id`, and referential integrity runs with `row_security = off`, so
   * a `project_id` or a `run_id` belonging to another tenant satisfied a
   * single-column key without anything ever looking at the org. The result was
   * a row the other tenant could not see — filtered out by their own policy —
   * that nonetheless existed, listed under their project id for whoever wrote
   * it, and told the writer by inserting successfully that the id they had
   * guessed at was real. An existence oracle is a small leak, but it is a leak,
   * and it was the last thing standing between a tenant boundary and a pair of
   * columns nobody had made agree. The keys are composite now, so the agreement
   * is checked where it cannot be forgotten.
   *
   * The same unconstrained `(org_id, project_id)` pair is still on `atoms`,
   * `documents`, `document_sections`, `section_extractions`, `atom_suppressions`
   * and `egress_events`. Phase 3 closed it on the two tables phase 3 added; the
   * rest is a migration of its own.
   */
  it("refuses a run whose project belongs to another org", async () => {
    await expect(
      asOrg(app, data.orgA, () =>
        app.query(
          `insert into reconciliation_runs
             (org_id, project_id, actor_id, trigger, verdict_count)
           values ($1, $2, $3, 'explicit', 0)`,
          [data.orgA, nextOrg.project, data.agentA],
        ),
      ),
    ).rejects.toThrow(/reconciliation_runs_project_in_org_fk/);
  });

  // Atom and run are chosen to agree with the foreign project, so the two keys
  // that already existed are both satisfied and this one is the only thing left
  // to refuse the row. Otherwise the test would pass on whichever key Postgres
  // happened to evaluate first.
  it("refuses a finding whose project belongs to another org", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        projectId: nextOrg.project,
        atomId: nextOrg.atom,
      }),
    ).rejects.toThrow(/reconciliation_findings_project_in_org_fk/);
  });

  it("refuses a finding whose run belongs to another org", async () => {
    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        runId: nextOrg.run,
      }),
    ).rejects.toThrow(/reconciliation_findings_run_in_org_fk/);
  });

  // Three composite keys on one row is enough of them to close the feature by
  // accident, so the ordinary shape gets written and read back here.
  it("still accepts a run and a finding that name their own org throughout", async () => {
    const read = await asOrg(app, data.orgA, async () => {
      const run = await app.query<{ id: string }>(
        `insert into reconciliation_runs
           (org_id, project_id, actor_id, trigger, verdict_count)
         values ($1, $2, $3, 'explicit', 1) returning id`,
        [data.orgA, data.projectA, data.agentA],
      );
      const runId = run.rows[0]?.id ?? "";
      const finding = await app.query(
        `insert into reconciliation_findings
           (org_id, project_id, run_id, atom_id, verdict, file_path, status)
         values ($1, $2, $3, $4, 'honored', 'src/native.ts', 'recorded')`,
        [data.orgA, data.projectA, runId, anchorAtom],
      );
      expect(finding.rowCount).toBe(1);
      return app.query(
        `select f.id from reconciliation_findings f
           join reconciliation_runs r on r.id = f.run_id and r.org_id = f.org_id
          where f.run_id = $1`,
        [runId],
      );
    });
    expect(read.rowCount).toBe(1);
  });

  // The cascade moved onto the composite key when the single-column key was
  // dropped, and a cascade that quietly stopped cascading leaves rows pointing
  // at a project that is gone.
  it("still takes a project's runs and findings with the project", async () => {
    const doomed = await elsewhere(data.orgA, "doomed-project");
    const db = await owner();
    try {
      await db.query(
        `insert into reconciliation_findings
           (org_id, project_id, run_id, atom_id, verdict, file_path, status)
         values ($1, $2, $3, $4, 'honored', 'src/doomed.ts', 'recorded')`,
        [data.orgA, doomed.project, doomed.run, doomed.atom],
      );

      await db.query("delete from projects where id = $1", [doomed.project]);

      const runs = await db.query(
        "select id from reconciliation_runs where project_id = $1",
        [doomed.project],
      );
      const findings = await db.query(
        "select id from reconciliation_findings where project_id = $1",
        [doomed.project],
      );
      expect(runs.rowCount).toBe(0);
      expect(findings.rowCount).toBe(0);
    } finally {
      await db.end();
    }
  });
});

describe("a run the schema refuses", () => {
  // `verdict_count` is the denominator of the false-positive rate. A negative
  // one is not a smaller number, it is a metric that cannot be read at all.
  it("a negative verdict count", async () => {
    await expect(
      asOrg(app, data.orgA, () =>
        app.query(
          `insert into reconciliation_runs
             (org_id, project_id, actor_id, trigger, verdict_count)
           values ($1, $2, $3, 'explicit', -1)`,
          [data.orgA, data.projectA, data.agentA],
        ),
      ),
    ).rejects.toThrow(/reconciliation_runs_verdict_count_nonneg/);
  });
});

describe("neither table can be edited away", () => {
  // Append-only by grant rather than by convention. A dismissed finding is the
  // numerator of our own kill metric, and the product does not get to delete
  // evidence against itself. 42501 is insufficient_privilege; the assertion
  // reads the SQLSTATE rather than a message that is one library upgrade from
  // changing.
  const refused = async (statement: string): Promise<string> => {
    try {
      await withActor(data.orgA, data.humanA, (db) => db.execute(statement));
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code ?? "no code";
    }
    return "not refused";
  };

  it("refuses a delete from reconciliation_findings", async () => {
    expect(await refused("delete from reconciliation_findings")).toBe("42501");
  });

  it("refuses a delete from reconciliation_runs", async () => {
    expect(await refused("delete from reconciliation_runs")).toBe("42501");
  });

  // Findings have UPDATE, because a human resolves one. Runs never do: a run is
  // a fact about a submission that already happened.
  it("refuses an update of reconciliation_runs", async () => {
    expect(
      await refused("update reconciliation_runs set verdict_count = 0"),
    ).toBe("42501");
  });
});

describe("recordReconciliation", () => {
  it("writes one run and every finding, with exactly the violations open", async () => {
    const atoms = await Promise.all([
      provisionalAtom(),
      provisionalAtom(),
      provisionalAtom(),
      provisionalAtom(),
    ]);

    const result = await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "post_edit",
        items: [
          { atomId: atoms[0] ?? "", verdict: "honored", filePath: "src/a.ts" },
          {
            atomId: atoms[1] ?? "",
            verdict: "violated",
            filePath: "src/b.ts",
            lineStart: 12,
            lineEnd: 14,
            rationale: "the handler swallows the error",
          },
          {
            atomId: atoms[2] ?? "",
            verdict: "not_applicable",
            filePath: "src/c.ts",
          },
          {
            atomId: atoms[3] ?? "",
            verdict: "unverifiable",
            filePath: "src/d.ts",
          },
        ],
      }),
    );

    expect(result).toMatchObject({ recorded: 4, open: 1 });

    // Read back through the raw client rather than trusting the return value:
    // the claim is about rows, and a repository that returned the right numbers
    // while writing one finding per call would satisfy the return value alone.
    const rows = await asOrg(app, data.orgA, async () => {
      const run = await app.query<{ verdict_count: number }>(
        "select verdict_count from reconciliation_runs where id = $1",
        [result.runId],
      );
      const findings = await app.query<{ status: string; verdict: string }>(
        "select status, verdict from reconciliation_findings where run_id = $1",
        [result.runId],
      );
      return { run: run.rows, findings: findings.rows };
    });

    expect(rows.run).toHaveLength(1);
    expect(rows.run[0]?.verdict_count).toBe(4);
    expect(rows.findings).toHaveLength(4);
    expect(rows.findings.filter((f) => f.status === "open")).toHaveLength(1);
    expect(rows.findings.find((f) => f.status === "open")?.verdict).toBe(
      "violated",
    );
  });

  // The parameter object has no count field, so there is nothing for a caller
  // to inflate: `verdict_count` is derived from the items about to be written.
  // This is the denominator of the metric that decides whether the phase ships,
  // and a client-supplied one would let a caller improve our false-positive
  // rate by lying about how much was checked.
  it("derives the verdict count from the rows it writes", async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      atomId: anchorAtom,
      verdict: "honored" as const,
      filePath: `src/derived-${i}.ts`,
    }));

    const result = await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "session_end",
        items,
      }),
    );

    const run = await asOrg(app, data.orgA, () =>
      app.query<{ verdict_count: number }>(
        "select verdict_count from reconciliation_runs where id = $1",
        [result.runId],
      ),
    );
    expect(run.rows[0]?.verdict_count).toBe(items.length);
  });
});

describe("resolveFinding", () => {
  /** One violation, committed, and the id of the finding it opened. */
  async function openFinding(): Promise<string> {
    const atomId = await provisionalAtom();
    const run = await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "post_edit",
        items: [
          {
            atomId,
            verdict: "violated",
            filePath: "src/open.ts",
            lineStart: 1,
            lineEnd: 2,
          },
        ],
      }),
    );

    const found = await asOrg(app, data.orgA, () =>
      app.query<{ id: string }>(
        "select id from reconciliation_findings where run_id = $1",
        [run.runId],
      ),
    );
    return found.rows[0]?.id ?? "";
  }

  it("moves an open finding to dismissed and stamps the human who did it", async () => {
    const findingId = await openFinding();

    const resolved = await withActor(data.orgA, data.humanA, (db) =>
      resolveFinding(db, findingId, data.humanA, "dismissed"),
    );

    expect(resolved?.status).toBe("dismissed");
    expect(resolved?.resolvedBy).toBe(data.humanA);
    expect(resolved?.resolvedByKind).toBe("human");
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
  });

  // The repository writes the literal `'human'` and lets the composite key
  // decide. It is the same refusal as ratification, and it is not enforced in
  // this function at all — which is the point: there is no route to forget it.
  it("refuses an agent", async () => {
    const findingId = await openFinding();

    const message = await refusal(() =>
      withActor(data.orgA, data.agentA, (db) =>
        resolveFinding(db, findingId, data.agentA, "dismissed"),
      ),
    );
    expect(message).toMatch(/reconciliation_findings_resolver_fk/);
  });

  // Conditional, not idempotent. The `status = 'open'` predicate matches no row
  // the second time and the caller turns that into a 409. There is no reopen
  // transition because the vocabulary has no state to reopen into.
  it("returns nothing for a finding that is already resolved", async () => {
    const findingId = await openFinding();

    const first = await withActor(data.orgA, data.humanA, (db) =>
      resolveFinding(db, findingId, data.humanA, "accepted"),
    );
    expect(first?.status).toBe("accepted");

    const second = await withActor(data.orgA, data.humanA, (db) =>
      resolveFinding(db, findingId, data.humanA, "dismissed"),
    );
    expect(second).toBeUndefined();
  });
});

describe("listFindings", () => {
  it("returns the queue and nothing else, a page at a time", async () => {
    // Two violations, so there is a second page to ask for, and one honored
    // verdict in the same run, so the filter has something to leave out.
    const atoms = await Promise.all([provisionalAtom(), provisionalAtom()]);
    await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "explicit",
        items: [
          {
            atomId: atoms[0] ?? "",
            verdict: "violated",
            filePath: "src/one.ts",
            lineStart: 1,
            lineEnd: 1,
          },
          {
            atomId: atoms[1] ?? "",
            verdict: "violated",
            filePath: "src/two.ts",
            lineStart: 2,
            lineEnd: 2,
          },
          { atomId: anchorAtom, verdict: "honored", filePath: "src/three.ts" },
        ],
      }),
    );

    const queue = await withActor(data.orgA, data.humanA, (db) =>
      listFindings(db, data.projectA, "open", pageOf()),
    );
    expect(queue.items.length).toBeGreaterThanOrEqual(2);
    expect(queue.items.every((f) => f.status === "open")).toBe(true);
    expect(queue.items.every((f) => f.verdict === "violated")).toBe(true);

    // Unfiltered, the recorded verdicts are there — so the filter above is
    // excluding them rather than the project simply having none.
    const everything = await withActor(data.orgA, data.humanA, (db) =>
      listFindings(db, data.projectA, undefined, pageOf()),
    );
    expect(everything.items.some((f) => f.status === "recorded")).toBe(true);

    const first = await withActor(data.orgA, data.humanA, (db) =>
      listFindings(db, data.projectA, "open", pageOf({ limit: 1 })),
    );
    const second = await withActor(data.orgA, data.humanA, (db) =>
      listFindings(db, data.projectA, "open", pageOf({ limit: 1, offset: 1 })),
    );

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect(first.total).toBe(queue.total);
    expect(first.total).toBeGreaterThan(1);
  });
});

describe("countDrift", () => {
  const drift = () =>
    withActor(data.orgA, data.humanA, (db) => countDrift(db, data.projectA));

  /**
   * Moves an atom's ratification to an instant the database itself names.
   *
   * `countDrift` asks whether a finding was recorded *since* an atom was last
   * ratified, so the test needs two instants it controls rather than two the
   * clock happens to produce a millisecond apart. Both are written by the
   * server here, which makes the assertion about the query rather than about
   * scheduling.
   *
   * This fixture was originally written to work around a real defect:
   * `ratifyAtom` stamped `ratified_at` from the *application* clock while a
   * finding's `created_at` comes from `now()` in Postgres, so on a host whose
   * clock ran ahead of the database's, a finding recorded after a ratification
   * landed before it and the atom stayed counted as unchecked. That is fixed —
   * `ratifyAtom` now writes `now()`, so both sides of the comparison come from
   * one clock — and the fixture is kept because pinning the instants is the
   * right way to test the predicate either way.
   */
  const ratifiedAt = (atomId: string, at: SQL) =>
    withActor(data.orgA, data.humanA, (db) =>
      db.execute(
        sql`update atoms set ratified_at = ${at} where id = ${atomId}::uuid`,
      ),
    );

  it("counts a violation into the queue and a resolution back out", async () => {
    const before = await drift();

    const atomId = await provisionalAtom();
    const run = await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "post_edit",
        items: [
          {
            atomId,
            verdict: "violated",
            filePath: "src/drift.ts",
            lineStart: 3,
            lineEnd: 4,
          },
        ],
      }),
    );
    expect((await drift()).openFindings).toBe(before.openFindings + 1);

    const found = await asOrg(app, data.orgA, () =>
      app.query<{ id: string }>(
        "select id from reconciliation_findings where run_id = $1",
        [run.runId],
      ),
    );
    await withActor(data.orgA, data.humanA, (db) =>
      resolveFinding(db, found.rows[0]?.id ?? "", data.humanA, "accepted"),
    );

    expect((await drift()).openFindings).toBe(before.openFindings);
  });

  /**
   * The behavioural consequence of the composite key, and the reason it is
   * worth having. `countDrift` groups findings by `atom_id` and nothing else,
   * so before the key a run in project A could file a verdict against project
   * B's atom and B's backlog would quietly shrink — a project's own drift
   * number moved by a neighbour it cannot see. The refusal below is what stops
   * it, and the count either side of the refusal is what proves it stopped.
   */
  it("leaves a neighbouring project's backlog alone", async () => {
    const neighbour = () =>
      withActor(data.orgA, data.humanA, (db) =>
        countDrift(db, nextProject.project),
      );

    const before = await neighbour();
    expect(before.canonicalUnchecked).toBeGreaterThan(0);

    await expect(
      insertFinding({
        verdict: "honored",
        status: "recorded",
        atomId: nextProject.atom,
      }),
    ).rejects.toThrow(/reconciliation_findings_atom_in_project_fk/);

    // And a run that is entirely legitimate in this project does not reach over
    // either — the project filter is the other half of the same claim.
    await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "explicit",
        items: [
          { atomId: anchorAtom, verdict: "honored", filePath: "src/n.ts" },
        ],
      }),
    );

    expect(await neighbour()).toEqual(before);
  });

  it("counts a canonical atom as unchecked until a finding newer than its ratification lands", async () => {
    const before = await drift();

    const atomId = await provisionalAtom();
    await withActor(data.orgA, data.humanA, (db) =>
      ratifyAtom(db, data.orgA, data.humanA, atomId),
    );
    const ratified = await drift();
    expect(ratified.canonicalUnchecked).toBe(before.canonicalUnchecked + 1);

    await ratifiedAt(atomId, sql`now() - interval '1 hour'`);
    await withActor(data.orgA, data.agentA, (db) =>
      recordReconciliation(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        actorId: data.agentA,
        trigger: "atom_ratified",
        items: [{ atomId, verdict: "honored", filePath: "src/checked.ts" }],
      }),
    );
    expect((await drift()).canonicalUnchecked).toBe(before.canonicalUnchecked);

    // Re-ratification makes the old finding stale: it was recorded against a
    // statement that has since been re-affirmed, so the atom owes a fresh one.
    // The new instant is read off the finding it has to outrank, which is the
    // ordering the query encodes.
    await ratifiedAt(
      atomId,
      sql`(select max(created_at) + interval '1 second'
             from reconciliation_findings
            where atom_id = ${atomId}::uuid)`,
    );
    expect((await drift()).canonicalUnchecked).toBe(
      before.canonicalUnchecked + 1,
    );
  });
});

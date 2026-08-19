import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  appClient,
  asOrg,
  BLANK_QUOTE_A,
  BLANK_SPAN_A,
  ensureTestRole,
  QUOTE_A,
  type Seed,
  SPAN_A,
  seed,
} from "./harness.js";

/**
 * docs/02-principles.md (8): falsify, don't confirm. Every test here attempts
 * the violation and asserts the failure. A suite that only checks the happy
 * path proves the feature works, not that the boundary holds.
 */

let app: Client;
let data: Seed;

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();
  app = await appClient();
});

afterAll(async () => {
  await app?.end();
});

describe("tenant isolation", () => {
  // Positive control, and it is not optional. If role membership were broken,
  // no policy would apply, RLS would deny everything, and every negative test
  // below would pass for entirely the wrong reason.
  it("sees its own org's documents", async () => {
    const rows = await asOrg(app, data.orgA, async () =>
      app.query("select id from documents"),
    );
    expect(rows.rowCount).toBeGreaterThan(0);
  });

  it("cannot read another org's documents", async () => {
    const rows = await asOrg(app, data.orgA, async () =>
      app.query("select id from documents where org_id = $1", [data.orgB]),
    );
    // RLS filters rather than raising, so the assertion is on the row count.
    expect(rows.rowCount).toBe(0);
  });

  it("cannot write a row into another org", async () => {
    await expect(
      asOrg(app, data.orgA, async () =>
        app.query(
          "insert into projects (org_id, name, slug) values ($1, 'x', 'x')",
          [data.orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  // Without the WITH CHECK half of the policy this passes silently, and a
  // tenant can park rows in another tenant's space that neither can see.
  it("cannot move an owned row into another org", async () => {
    await expect(
      asOrg(app, data.orgA, async () =>
        app.query("update projects set org_id = $1 where org_id = $2", [
          data.orgB,
          data.orgA,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  // Fail closed. `current_setting(..., true)` returns NULL when unset, and
  // `org_id = NULL` is never true — so a forgotten set_config must yield
  // nothing, not everything.
  it("returns nothing when the tenant GUC is unset", async () => {
    await app.query("begin");
    try {
      const rows = await app.query("select id from documents");
      expect(rows.rowCount).toBe(0);
    } finally {
      await app.query("rollback");
    }
  });
});

describe("invariant 2 — an agent cannot promote its own knowledge", () => {
  const insertAtom = (
    status: string,
    ratifier: string | null,
    kind: string | null,
  ) =>
    asOrg(app, data.orgA, async () =>
      app.query(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind,
            status, source_quote, source_span, ratified_by, ratified_by_kind,
            ratified_at)
         values ($1, $2, $3, $4, 'a statement', 'decision',
            $5, $8, $9::int4range, $6, $7,
            case when $6::uuid is null then null else now() end)`,
        [
          data.orgA,
          data.projectA,
          data.documentA,
          data.sectionA,
          status,
          ratifier,
          kind,
          // Real provenance, because the quote trigger now checks it. These
          // tests are about who may ratify; a fabricated quote would make them
          // fail for a reason they are not asking about.
          QUOTE_A,
          SPAN_A,
        ],
      ),
    );

  it("accepts a provisional atom with no ratifier", async () => {
    await expect(insertAtom("provisional", null, null)).resolves.toBeDefined();
  });

  it("accepts ratification by a human", async () => {
    await expect(
      insertAtom("canonical", data.humanA, "human"),
    ).resolves.toBeDefined();
  });

  // The composite foreign key to actors(id, kind) forces the claimed kind to
  // match reality; the check then rejects anything that is not human.
  it("rejects ratification by an agent", async () => {
    await expect(insertAtom("canonical", data.agentA, "agent")).rejects.toThrow(
      /atoms_ratifier_is_human/,
    );
  });

  // Claiming 'human' for an agent's id fails the foreign key instead.
  it("rejects an agent id disguised as a human", async () => {
    await expect(insertAtom("canonical", data.agentA, "human")).rejects.toThrow(
      /atoms_ratified_by_human_fk/,
    );
  });

  it("rejects canonical status with no ratifier at all", async () => {
    await expect(insertAtom("canonical", null, null)).rejects.toThrow(
      /atoms_canonical_requires_ratification/,
    );
  });
});

describe("invariant 1 — atoms are a projection of documents", () => {
  // The span genuinely names whitespace, so the quote trigger passes and the
  // check is what refuses the row. Any other span would be rejected a step
  // earlier and this constraint would go untested.
  it("rejects an atom whose provenance quote is blank", async () => {
    await expect(
      asOrg(app, data.orgA, async () =>
        app.query(
          `insert into atoms
             (org_id, project_id, document_id, section_id, statement, kind,
              source_quote, source_span)
           values ($1, $2, $3, $4, 's', 'decision', $5, $6::int4range)`,
          [
            data.orgA,
            data.projectA,
            data.documentA,
            data.sectionA,
            BLANK_QUOTE_A,
            BLANK_SPAN_A,
          ],
        ),
      ),
    ).rejects.toThrow(/atoms_source_quote_not_blank/);
  });

  it("rejects an atom with no section to cite", async () => {
    await expect(
      asOrg(app, data.orgA, async () =>
        app.query(
          `insert into atoms
             (org_id, project_id, document_id, statement, kind,
              source_quote, source_span)
           values ($1, $2, $3, 's', 'decision', 'q', '[0,10)')`,
          [data.orgA, data.projectA, data.documentA],
        ),
      ),
    ).rejects.toThrow(/section_id/);
  });

  it("deletes atoms when their document goes", async () => {
    const admin = await adminClient();
    try {
      const doc = await admin.query<{ id: string }>(
        `insert into documents (org_id, project_id, path, body, content_hash)
         values ($1, $2, 'docs/tmp.md', '# t', 'h') returning id`,
        [data.orgA, data.projectA],
      );
      const documentId = doc.rows[0]?.id;
      const section = await admin.query<{ id: string }>(
        `insert into document_sections (org_id, document_id, ordinal, heading_path, body, section_hash)
         values ($1, $2, 0, ARRAY['t'], 't', 'h') returning id`,
        [data.orgA, documentId],
      );
      // The section body is the single character 't', so that is the only quote
      // the trigger will accept and '[0,1)' the only span that names it.
      await admin.query(
        `insert into atoms (org_id, project_id, document_id, section_id, statement, kind, source_quote, source_span)
         values ($1, $2, $3, $4, 's', 'decision', 't', '[0,1)')`,
        [data.orgA, data.projectA, documentId, section.rows[0]?.id],
      );

      await admin.query("delete from documents where id = $1", [documentId]);

      const left = await admin.query(
        "select id from atoms where document_id = $1",
        [documentId],
      );
      expect(left.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});

describe("atom_events is append-only", () => {
  it("refuses an update", async () => {
    await expect(
      asOrg(app, data.orgA, async () =>
        app.query("update atom_events set event = 'rejected'"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a delete", async () => {
    await expect(
      asOrg(app, data.orgA, async () => app.query("delete from atom_events")),
    ).rejects.toThrow(/permission denied/i);
  });
});

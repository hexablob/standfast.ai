import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  appClient,
  asOrg,
  ensureTestRole,
  type Seed,
  seed,
} from "./harness.js";

/**
 * Migration 0010 — every foreign key between two org-scoped tables carries
 * `org_id`.
 *
 * Row-level security compares the row's `org_id` against the session GUC and
 * stops there. It has no opinion on whether the row's *other* foreign keys
 * agree with that `org_id`, and referential integrity runs with
 * `row_security = off`, so before 0010 a single-column key was satisfied by a
 * parent in any tenant at all. The row that resulted was invisible to the org
 * it pointed into — filtered out by their policy — yet it existed, it listed
 * under their id for whoever wrote it, and the insert succeeding told the
 * writer that an id they had guessed was real. An existence oracle is a small
 * leak; a tenant boundary that depends on the route remembering is not a
 * boundary. The keys are composite now, so the agreement is checked in the one
 * place it cannot be forgotten.
 *
 * Every refusal below runs through the unprivileged role with
 * `standfast.org_id` set to org A, which is how production reaches the
 * database. As the superuser these would all pass while proving nothing.
 */

let app: Client;
let data: Seed;

/** A complete chain in org A, and one in org B to point at across the border. */
let here: Chain;
let there: Chain;

type Chain = {
  project: string;
  document: string;
  section: string;
  atom: string;
  human: string;
  agent: string;
};

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();
  app = await appClient();

  const db = await adminClient();
  try {
    here = await chain(db, data.orgA, "here");
    there = await chain(db, data.orgB, "there");
  } finally {
    await db.end();
  }
});

afterAll(async () => {
  await app?.end();
});

/**
 * A whole org-scoped chain, committed by the superuser.
 *
 * Every test in this file needs a parent row on the far side of a tenant
 * boundary, and `standfast_app` cannot create one — that is the property under
 * test. So the fixtures are written as the superuser, which bypasses RLS, and
 * only the attempts to *use* them run as the app role. Body 't', quote 't' and
 * span '[0,1)' is the smallest text the atoms quote trigger accepts.
 */
async function chain(db: Client, orgId: string, slug: string): Promise<Chain> {
  const one = async (statement: string, values: unknown[]): Promise<string> =>
    (await db.query<{ id: string }>(statement, values)).rows[0]?.id ?? "";

  const project = await one(
    "insert into projects (org_id, name, slug) values ($1, $2, $2) returning id",
    [orgId, slug],
  );
  const document = await one(
    `insert into documents (org_id, project_id, path, body, content_hash)
     values ($1, $2, 'docs/t.md', 't', $3) returning id`,
    [orgId, project, `hash-${slug}`],
  );
  const section = await one(
    `insert into document_sections
       (org_id, document_id, ordinal, heading_path, body, section_hash)
     values ($1, $2, 0, ARRAY['t'], 't', $3) returning id`,
    [orgId, document, `section-${slug}`],
  );
  const atom = await one(
    `insert into atoms
       (org_id, project_id, document_id, section_id, statement, kind,
        source_quote, source_span)
     values ($1, $2, $3, $4, 's', 'decision', 't', '[0,1)') returning id`,
    [orgId, project, document, section],
  );
  const human = await one(
    "insert into actors (org_id, kind, display_name) values ($1, 'human', $2) returning id",
    [orgId, slug],
  );
  const agent = await one(
    "insert into actors (org_id, kind, display_name) values ($1, 'agent', $2) returning id",
    [orgId, slug],
  );
  return { project, document, section, atom, human, agent };
}

/** One write as the app role in org A, in a transaction that is rolled back. */
function write(statement: string, values: unknown[]): Promise<unknown> {
  return asOrg(app, data.orgA, () => app.query(statement, values));
}

describe("a row cannot name another org's parent", () => {
  // One representative key per table. Each row is built so that every *other*
  // constraint on it is satisfied and the named key is the only thing left to
  // refuse it — otherwise the test would pass on whichever constraint Postgres
  // happened to evaluate first, and would keep passing after the key it claims
  // to guard was dropped.

  it("refuses a document in another org's project", async () => {
    await expect(
      write(
        `insert into documents (org_id, project_id, path, body, content_hash)
         values ($1, $2, 'docs/x.md', 't', 'hash-x')`,
        [data.orgA, there.project],
      ),
    ).rejects.toThrow(/documents_project_in_org_fk/);
  });

  it("refuses a section in another org's document", async () => {
    await expect(
      write(
        `insert into document_sections
           (org_id, document_id, ordinal, heading_path, body, section_hash)
         values ($1, $2, 0, ARRAY['t'], 't', 'section-x')`,
        [data.orgA, there.document],
      ),
    ).rejects.toThrow(/document_sections_document_in_org_fk/);
  });

  /**
   * The atom names its *own* document and section and only the project is
   * foreign. The quote trigger is not SECURITY DEFINER, so it reads
   * `document_sections` under the caller's own policy: point an atom at another
   * org's section and the trigger fails to find the body long before any key is
   * consulted, and the test would assert a refusal that has nothing to do with
   * 0010. The section is pinned to its org anyway, transitively, by
   * `atoms_document_section_fk` and `atoms_document_in_org_fk` together.
   */
  it("refuses an atom in another org's project", async () => {
    await expect(
      write(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind,
            source_quote, source_span)
         values ($1, $2, $3, $4, 's', 'decision', 't', '[0,1)')`,
        [data.orgA, there.project, here.document, here.section],
      ),
    ).rejects.toThrow(/atoms_project_in_org_fk/);
  });

  it("refuses an event about another org's atom", async () => {
    await expect(
      write(
        `insert into atom_events (org_id, atom_id, event, actor_id)
         values ($1, $2, 'proposed', $3)`,
        [data.orgA, there.atom, here.human],
      ),
    ).rejects.toThrow(/atom_events_atom_in_org_fk/);
  });

  it("refuses an extraction over another org's section", async () => {
    await expect(
      write(
        `insert into section_extractions
           (org_id, section_id, extractor_version, section_hash, project_id)
         values ($1, $2, 'v1', 'section-x', $3)`,
        [data.orgA, there.section, here.project],
      ),
    ).rejects.toThrow(/section_extractions_section_in_org_fk/);
  });

  it("refuses a suppression naming another org's atom as the duplicate", async () => {
    await expect(
      write(
        `insert into atom_suppressions
           (org_id, project_id, section_id, statement, reason, duplicate_of_atom_id)
         values ($1, $2, $3, 's', 'duplicate', $4)`,
        [data.orgA, here.project, here.section, there.atom],
      ),
    ).rejects.toThrow(/atom_suppressions_duplicate_of_in_org_fk/);
  });

  it("refuses an egress event attributed to another org's section", async () => {
    await expect(
      write(
        `insert into egress_events
           (org_id, project_id, section_id, purpose, destination, model,
            input_items, input_chars)
         values ($1, $2, $3, 'extraction', 'example.test', 'm-1', 1, 1)`,
        [data.orgA, here.project, there.section],
      ),
    ).rejects.toThrow(/egress_events_section_in_org_fk/);
  });

  // The one that would hand over an actual credential: a key minted in org A
  // against an actor who belongs to org B.
  it("refuses an api key for another org's actor", async () => {
    await expect(
      write(
        `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
         values ($1, $2, 'sk_x', 'hash-x', ARRAY['read'])`,
        [data.orgA, there.human],
      ),
    ).rejects.toThrow(/api_keys_actor_in_org_fk/);
  });
});

describe("a deleted parent nulls the pointer and leaves the tenant", () => {
  // Both of these keys are written in the column-list form,
  // `ON DELETE SET NULL (one_column)`, and that is the whole point of them.
  // The bare form nulls every column in the key, `org_id` included — and
  // `org_id` is NOT NULL, so the delete would not degrade to an orphan, it
  // would raise. A parent going away has to be survivable for the child.

  it("keeps an egress event when its section is deleted", async () => {
    const db = await adminClient();
    try {
      const own = await chain(db, data.orgA, "egress-null");
      const event = await db.query<{ id: string }>(
        `insert into egress_events
           (org_id, project_id, section_id, purpose, destination, model,
            input_items, input_chars)
         values ($1, $2, $3, 'extraction', 'example.test', 'm-1', 1, 1)
         returning id`,
        [data.orgA, own.project, own.section],
      );

      await db.query("delete from document_sections where id = $1", [
        own.section,
      ]);

      const after = await db.query<{
        section_id: string | null;
        org_id: string;
      }>("select section_id, org_id from egress_events where id = $1", [
        event.rows[0]?.id,
      ]);
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]?.section_id).toBeNull();
      expect(after.rows[0]?.org_id).toBe(data.orgA);
    } finally {
      await db.end();
    }
  });

  it("keeps a suppression when the atom it duplicated is deleted", async () => {
    const db = await adminClient();
    try {
      const own = await chain(db, data.orgA, "suppression-null");
      const suppression = await db.query<{ id: string }>(
        `insert into atom_suppressions
           (org_id, project_id, section_id, statement, reason, duplicate_of_atom_id)
         values ($1, $2, $3, 's', 'duplicate', $4) returning id`,
        [data.orgA, own.project, own.section, own.atom],
      );

      await db.query("delete from atoms where id = $1", [own.atom]);

      const after = await db.query<{
        duplicate_of_atom_id: string | null;
        org_id: string;
      }>(
        "select duplicate_of_atom_id, org_id from atom_suppressions where id = $1",
        [suppression.rows[0]?.id],
      );
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]?.duplicate_of_atom_id).toBeNull();
      expect(after.rows[0]?.org_id).toBe(data.orgA);
    } finally {
      await db.end();
    }
  });
});

describe("deleting a project still empties it", () => {
  // Sixteen keys were replaced, each carrying an `ON DELETE` that had to be
  // copied across by hand. A single wrong one either orphans rows against a
  // project that no longer exists or destroys rows that should have survived,
  // and neither announces itself. This walks the whole tree in one delete.
  it("takes the documents, sections, atoms and everything hung off them", async () => {
    const db = await adminClient();
    try {
      const own = await chain(db, data.orgA, "doomed");
      await db.query(
        `insert into section_extractions
           (org_id, section_id, extractor_version, section_hash, project_id)
         values ($1, $2, 'v1', 'section-doomed', $3)`,
        [data.orgA, own.section, own.project],
      );
      await db.query(
        `insert into atom_suppressions
           (org_id, project_id, section_id, statement, reason)
         values ($1, $2, $3, 's', 'noise')`,
        [data.orgA, own.project, own.section],
      );
      await db.query(
        `insert into egress_events
           (org_id, project_id, section_id, purpose, destination, model,
            input_items, input_chars)
         values ($1, $2, $3, 'extraction', 'example.test', 'm-1', 1, 1)`,
        [data.orgA, own.project, own.section],
      );
      await db.query(
        `insert into atom_events (org_id, atom_id, event, actor_id)
         values ($1, $2, 'proposed', $3)`,
        [data.orgA, own.atom, own.human],
      );

      const survivors = async (): Promise<Record<string, number>> => {
        const counts = await db.query<{ table_name: string; n: string }>(
          `select 'documents' as table_name, count(*)::text as n from documents where project_id = $1
           union all select 'document_sections', count(*)::text from document_sections where document_id = $2
           union all select 'atoms', count(*)::text from atoms where project_id = $1
           union all select 'section_extractions', count(*)::text from section_extractions where project_id = $1
           union all select 'atom_suppressions', count(*)::text from atom_suppressions where project_id = $1
           union all select 'egress_events', count(*)::text from egress_events where project_id = $1
           union all select 'atom_events', count(*)::text from atom_events where atom_id = $3`,
          [own.project, own.document, own.atom],
        );
        return Object.fromEntries(
          counts.rows.map((r) => [r.table_name, Number(r.n)]),
        );
      };

      // Asserted before as well as after: a cascade test that never had rows to
      // begin with passes for the wrong reason and is worse than no test.
      expect(await survivors()).toEqual({
        documents: 1,
        document_sections: 1,
        atoms: 1,
        section_extractions: 1,
        atom_suppressions: 1,
        egress_events: 1,
        atom_events: 1,
      });

      await db.query("delete from projects where id = $1", [own.project]);

      expect(await survivors()).toEqual({
        documents: 0,
        document_sections: 0,
        atoms: 0,
        section_extractions: 0,
        atom_suppressions: 0,
        egress_events: 0,
        atom_events: 0,
      });
    } finally {
      await db.end();
    }
  });
});

describe("an atom is superseded only from inside its own org", () => {
  // The self-referencing key. `superseded_by` is NO ACTION rather than CASCADE
  // on purpose — superseding is the audit trail, and deleting the atom that
  // replaced one must not quietly take the record of the replacement with it.
  it("accepts a successor in the same org", async () => {
    // Successor and update both inside one `asOrg`, which rolls back — so the
    // atom the rest of the file points at is left as it was found.
    const updated = await asOrg(app, data.orgA, async () => {
      const successor = await app.query<{ id: string }>(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind,
            source_quote, source_span)
         values ($1, $2, $3, $4, 'successor', 'decision', 't', '[0,1)')
         returning id`,
        [data.orgA, here.project, here.document, here.section],
      );
      return app.query(
        "update atoms set superseded_by = $1, status = 'superseded' where id = $2",
        [successor.rows[0]?.id, here.atom],
      );
    });
    expect(updated.rowCount).toBe(1);
  });

  it("refuses a successor in another org", async () => {
    await expect(
      write(
        "update atoms set superseded_by = $1, status = 'superseded' where id = $2",
        [there.atom, here.atom],
      ),
    ).rejects.toThrow(/atoms_superseded_by_in_org_fk/);
  });
});

describe("the schema keeps no single-column key between org-scoped tables", () => {
  /**
   * The guard that makes the whole class fail loudly rather than one table at a
   * time. Every test above is a fixture against one key that exists today; this
   * one is against the next table somebody adds without thinking about it.
   *
   * "Org-scoped" is read off the schema — a table with an `org_id` column —
   * rather than from a list here, so a new table is covered the day it is
   * created and nobody has to remember to add it. References to `orgs` itself
   * are excluded: `org_id -> orgs(id)` is the one single-column key that is
   * correct by definition.
   *
   * Composite keys that carry a dimension other than `org_id` are not offenders
   * and are not counted: `atoms_document_section_fk` pins a section to its
   * document and `atoms_ratified_by_human_fk` pins an actor to their kind, and
   * each sits beside an `_in_org_fk` that pins the same row to the org. What
   * this asserts is the narrower, checkable thing — that no key between two
   * org-scoped tables is down to a single column.
   */
  it("finds none", async () => {
    const db = await adminClient();
    try {
      const offenders = await db.query<{ offender: string }>(
        `select src.relname || '.' || c.conname || ' -> ' || tgt.relname as offender
           from pg_constraint c
           join pg_class src on src.oid = c.conrelid
           join pg_class tgt on tgt.oid = c.confrelid
          where c.contype = 'f'
            and array_length(c.conkey, 1) = 1
            and tgt.relname <> 'orgs'
            and exists (select 1 from pg_attribute a
                         where a.attrelid = c.conrelid and a.attname = 'org_id'
                           and a.attnum > 0 and not a.attisdropped)
            and exists (select 1 from pg_attribute a
                         where a.attrelid = c.confrelid and a.attname = 'org_id'
                           and a.attnum > 0 and not a.attisdropped)
          order by 1`,
      );
      // Compared as a list rather than a count, so a failure names the key.
      expect(offenders.rows.map((r) => r.offender)).toEqual([]);
    } finally {
      await db.end();
    }
  });
});

describe("the ordinary chain is untouched", () => {
  // Sixteen new constraints is enough of them to close the product by accident.
  // This writes the whole tree as the app role, in one org, and reads it back
  // through joins that require the org to agree at every hop.
  it("writes and reads a project, document, section, atom and extraction", async () => {
    const rows = await asOrg(app, data.orgA, async () => {
      const one = async (
        statement: string,
        values: unknown[],
      ): Promise<string> =>
        (await app.query<{ id: string }>(statement, values)).rows[0]?.id ?? "";

      const project = await one(
        "insert into projects (org_id, name, slug) values ($1, 'Native', 'native') returning id",
        [data.orgA],
      );
      const document = await one(
        `insert into documents (org_id, project_id, path, body, content_hash)
         values ($1, $2, 'docs/n.md', 't', 'hash-n') returning id`,
        [data.orgA, project],
      );
      const section = await one(
        `insert into document_sections
           (org_id, document_id, ordinal, heading_path, body, section_hash)
         values ($1, $2, 0, ARRAY['t'], 't', 'section-n') returning id`,
        [data.orgA, document],
      );
      const atom = await one(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind,
            source_quote, source_span)
         values ($1, $2, $3, $4, 's', 'decision', 't', '[0,1)') returning id`,
        [data.orgA, project, document, section],
      );
      await app.query(
        `insert into section_extractions
           (org_id, section_id, extractor_version, section_hash, project_id)
         values ($1, $2, 'v1', 'section-n', $3)`,
        [data.orgA, section, project],
      );

      return app.query(
        `select a.id
           from atoms a
           join document_sections s
             on s.id = a.section_id and s.org_id = a.org_id
           join documents d
             on d.id = a.document_id and d.org_id = a.org_id
           join projects p
             on p.id = a.project_id and p.org_id = a.org_id
           join section_extractions e
             on e.section_id = s.id and e.org_id = s.org_id
          where a.id = $1`,
        [atom],
      );
    });

    expect(rows.rowCount).toBe(1);
  });
});

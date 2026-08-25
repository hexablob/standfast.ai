import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import {
  createAtom,
  ratifyAtom,
  rejectAtom,
  retireAtom,
} from "../repositories/atoms.js";
import {
  retrieveCandidates,
  setRetrievalGucs,
} from "../repositories/retrieval.js";
import {
  adminUrl,
  appClient,
  ensureTestRole,
  QUOTE_A,
  SECTION_A_BODY,
  type Seed,
  seed,
} from "./harness.js";

/**
 * Phase 4a — the three decisions beyond ratify, and what each one refuses.
 *
 * `docs/15-ratification.md` names four decisions and gives three of them a
 * write: reject, ratify-superseding, and — from migration 0012 — retire. Each
 * has a precondition that is a transition rather than a value, and a transition
 * enforced in a `WHERE` is only enforced if something has watched it refuse.
 *
 * Two of these tests are load-bearing beyond their own assertion. The supersede
 * rollback is the reason superseding is a field on ratify rather than a fifth
 * route, and it is the only test here whose failure would corrupt data rather
 * than merely permit a bad request. The agent-cannot-reject test is the
 * opposite: it documents a guard the database does *not* provide, and says so.
 *
 * Everything runs through the unprivileged role, the way production reaches the
 * database. As the superuser RLS would not apply to a single row read here.
 */

let app: Client;
let data: Seed;
const originalUrl = process.env["DATABASE_URL"];

/** A canonical atom in a second project of the same org. */
let otherProject = { project: "", atom: "" };

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();

  app = await appClient();
  otherProject = await elsewhere("next-project");
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
 *
 * `statement` is free text and `sourceQuote` is not, which is what lets the
 * retrieval test below give one atom a distinctive statement while every
 * fixture quotes the same seeded line.
 */
async function provisionalAtom(statement = QUOTE_A): Promise<string> {
  const start = SECTION_A_BODY.indexOf(QUOTE_A);
  return withActor(data.orgA, data.agentA, async (db) => {
    const atom = await createAtom(db, data.orgA, data.agentA, {
      projectId: data.projectA,
      documentId: data.documentA,
      sectionId: data.sectionA,
      statement,
      kind: "convention",
      sourceQuote: QUOTE_A,
      sourceSpan: { start, end: start + QUOTE_A.length },
    });
    return atom.id;
  });
}

/** The same, ratified — the only supported way to reach `canonical`. */
async function canonicalAtom(statement = QUOTE_A): Promise<string> {
  const id = await provisionalAtom(statement);
  await withActor(data.orgA, data.humanA, (db) =>
    ratifyAtom(db, data.orgA, data.humanA, id),
  );
  return id;
}

async function statusOf(atomId: string): Promise<string> {
  const rows = await withActor(data.orgA, data.humanA, (db) =>
    db.execute<{ status: string; superseded_by: string | null }>(
      sql`select status, superseded_by from atoms where id = ${atomId}`,
    ),
  );
  return rows.rows[0]?.status ?? "";
}

async function supersededByOf(atomId: string): Promise<string | null> {
  const rows = await withActor(data.orgA, data.humanA, (db) =>
    db.execute<{ superseded_by: string | null }>(
      sql`select superseded_by from atoms where id = ${atomId}`,
    ),
  );
  return rows.rows[0]?.superseded_by ?? null;
}

/** Every ledger entry for one atom, oldest first. */
async function eventsOf(atomId: string): Promise<
  {
    event: string;
    actor_id: string;
    reason: string | null;
    reason_note: string | null;
  }[]
> {
  const rows = await withActor(data.orgA, data.humanA, (db) =>
    db.execute<{
      event: string;
      actor_id: string;
      reason: string | null;
      reason_note: string | null;
    }>(
      // `at` defaults to the transaction clock, and every event on one atom is
      // written by a separate decision, so no two here can tie.
      sql`select event, actor_id, reason, reason_note from atom_events
          where atom_id = ${atomId} order by at`,
    ),
  );
  return rows.rows;
}

/**
 * A superuser connection.
 *
 * `adminClient` reads `DATABASE_URL`, which this file repoints at the
 * unprivileged role for the duration of the suite, so the owner's URL is taken
 * from the value captured before the swap.
 */
async function owner(): Promise<Client> {
  const client = new Client({ connectionString: originalUrl ?? "" });
  await client.connect();
  return client;
}

/**
 * A second project in the same org, holding one canonical atom.
 *
 * The same org deliberately. Cross-org is already refused by RLS and by the
 * org-scoped foreign keys, so an incumbent from the next org over would be
 * refused for a reason that has nothing to do with the project check under
 * test. The interesting boundary is the one inside a tenant, where every row is
 * visible and only `project_id` separates them.
 *
 * Body 't', quote 't', span '[0,1)' is the smallest text the atom trigger takes.
 */
async function elsewhere(
  slug: string,
): Promise<{ project: string; atom: string }> {
  const db = await owner();
  try {
    const one = async (statement: string, values: unknown[]): Promise<string> =>
      (await db.query<{ id: string }>(statement, values)).rows[0]?.id ?? "";

    const project = await one(
      "insert into projects (org_id, name, slug) values ($1, $2, $2) returning id",
      [data.orgA, slug],
    );
    const document = await one(
      `insert into documents (org_id, project_id, path, body, content_hash)
       values ($1, $2, 'docs/e.md', 't', 'h-e') returning id`,
      [data.orgA, project],
    );
    const section = await one(
      `insert into document_sections
         (org_id, document_id, ordinal, heading_path, body, section_hash)
       values ($1, $2, 0, ARRAY['t'], 't', 'h-e') returning id`,
      [data.orgA, document],
    );
    const atom = await one(
      `insert into atoms
         (org_id, project_id, document_id, section_id, statement, kind, status,
          ratified_by, ratified_by_kind, ratified_at, source_quote, source_span)
       values ($1, $2, $3, $4, 's', 'decision', 'canonical', $5, 'human', now(), 't', '[0,1)')
       returning id`,
      [data.orgA, project, document, section, data.humanA],
    );
    return { project, atom };
  } finally {
    await db.end();
  }
}

describe("rejectAtom", () => {
  it("moves a provisional atom to rejected and writes the ledger entry", async () => {
    const atomId = await provisionalAtom();

    const rejected = await withActor(data.orgA, data.humanA, (db) =>
      rejectAtom(
        db,
        data.orgA,
        data.humanA,
        atomId,
        "duplicate",
        "already covered by the convention above",
      ),
    );

    expect(rejected?.status).toBe("rejected");

    // Not a ratification. `countDrift` reads `ratified_at` to find canonical
    // atoms nothing has checked since they were ratified, so a rejection that
    // stamped it would put a terminal atom into a queue of live ones.
    expect(rejected?.ratifiedBy).toBeNull();
    expect(rejected?.ratifiedAt).toBeNull();

    const events = await eventsOf(atomId);
    expect(events.map((e) => e.event)).toEqual(["proposed", "rejected"]);
    expect(events[1]?.reason).toBe("duplicate");
    expect(events[1]?.reason_note).toBe(
      "already covered by the convention above",
    );
    expect(events[1]?.actor_id).toBe(data.humanA);
  });

  it("accepts a rejection with no reason at all", async () => {
    const atomId = await provisionalAtom();

    const rejected = await withActor(data.orgA, data.humanA, (db) =>
      rejectAtom(db, data.orgA, data.humanA, atomId),
    );

    // Optional on purpose: a required field turns a decision into a form, and a
    // reviewer made to justify a rejection ratifies marginal atoms instead.
    expect(rejected?.status).toBe("rejected");
    const events = await eventsOf(atomId);
    expect(events[1]?.event).toBe("rejected");
    expect(events[1]?.reason).toBeNull();
    expect(events[1]?.reason_note).toBeNull();
  });

  it("refuses any atom that is not provisional", async () => {
    const canonical = await canonicalAtom();

    const rejectedOnce = await provisionalAtom();
    await withActor(data.orgA, data.humanA, (db) =>
      rejectAtom(db, data.orgA, data.humanA, rejectedOnce),
    );

    const retired = await canonicalAtom();
    await withActor(data.orgA, data.humanA, (db) =>
      retireAtom(db, data.orgA, data.humanA, retired),
    );

    // Undefined rather than a throw, because the route owes this a 409: the
    // request was well formed and the atom had already been decided.
    for (const atomId of [canonical, rejectedOnce, retired]) {
      const again = await withActor(data.orgA, data.humanA, (db) =>
        rejectAtom(db, data.orgA, data.humanA, atomId),
      );
      expect(again).toBeUndefined();
    }

    // A refused reject writes nothing, so the ledger still ends where it did.
    expect((await eventsOf(rejectedOnce)).length).toBe(2);
    expect(await statusOf(canonical)).toBe("canonical");
  });
});

describe("retireAtom", () => {
  it("moves a canonical atom to retired and writes the ledger entry", async () => {
    const atomId = await canonicalAtom();

    const retired = await withActor(data.orgA, data.humanA, (db) =>
      retireAtom(db, data.orgA, data.humanA, atomId),
    );

    expect(retired?.status).toBe("retired");
    // No successor: retiring is what a project does when a decision stops
    // applying and nothing replaces it, which is exactly what distinguishes it
    // from superseding.
    expect(retired?.supersededBy).toBeNull();

    const events = await eventsOf(atomId);
    expect(events.map((e) => e.event)).toEqual([
      "proposed",
      "ratified",
      "retired",
    ]);
    expect(events[2]?.reason).toBeNull();
  });

  it("refuses a provisional atom", async () => {
    const atomId = await provisionalAtom();

    // Retiring is a withdrawal of something the project agreed to. A
    // provisional atom was never agreed to, and the decision it wants is
    // reject — which is the distinction migration 0012 exists to preserve.
    const retired = await withActor(data.orgA, data.humanA, (db) =>
      retireAtom(db, data.orgA, data.humanA, atomId),
    );

    expect(retired).toBeUndefined();
    expect(await statusOf(atomId)).toBe("provisional");
  });
});

describe("only a human decides", () => {
  /**
   * Refused by application code, and this test says so rather than implying
   * otherwise.
   *
   * Two layers, and the test checks both.
   *
   * The repository refuses first, with a correlated `EXISTS` inside the
   * UPDATE's own `WHERE`, so there is no window between testing the kind and
   * writing the row and no ordering for a caller to get wrong. That is what
   * produces the readable error.
   *
   * The database refuses underneath it, which is what makes the rule a
   * guarantee rather than a habit. Migration 0013 added `atom_events.actor_kind`
   * — filled by a trigger from `actors`, never by the caller — a composite key
   * to `actors (id, kind)`, and a check that every event except `proposed`
   * belongs to a human. The last two assertions step around the repository
   * entirely and watch the database say no, including when the caller forges
   * `actor_kind = 'human'`: the trigger overwrites the claim before the check
   * reads it.
   *
   * This test previously ended by demonstrating the opposite — the database
   * accepting an agent's `rejected` event — because at the time nothing refused
   * it. That assertion is now inverted rather than deleted; it is the same
   * probe, and its answer changed.
   */
  it("an agent cannot reject or retire, and the database is the one refusing", async () => {
    const provisional = await provisionalAtom();
    const canonical = await canonicalAtom();

    await expect(
      withActor(data.orgA, data.agentA, (db) =>
        rejectAtom(db, data.orgA, data.agentA, provisional),
      ),
    ).rejects.toThrow(/only a human/);

    await expect(
      withActor(data.orgA, data.agentA, (db) =>
        retireAtom(db, data.orgA, data.agentA, canonical),
      ),
    ).rejects.toThrow(/only a human/);

    expect(await statusOf(provisional)).toBe("provisional");
    expect(await statusOf(canonical)).toBe("canonical");
    expect((await eventsOf(provisional)).map((e) => e.event)).toEqual([
      "proposed",
    ]);

    // Stepping around the repository entirely: the database refuses on its own.
    const direct = await refusal(() =>
      withActor(data.orgA, data.agentA, (db) =>
        db.execute(
          sql`insert into atom_events (org_id, atom_id, event, actor_id, reason)
              values (${data.orgA}, ${provisional}, 'rejected', ${data.agentA}, 'not_true')`,
        ),
      ),
    );
    expect(direct).toMatch(/atom_events_decision_is_human/);

    // And claiming to be a human does not help: the trigger derives the kind
    // from `actors` and overwrites whatever was sent, so the check sees the
    // truth rather than the claim.
    const forged = await refusal(() =>
      withActor(data.orgA, data.agentA, (db) =>
        db.execute(
          sql`insert into atom_events (org_id, atom_id, event, actor_id, actor_kind)
              values (${data.orgA}, ${provisional}, 'rejected', ${data.agentA}, 'human')`,
        ),
      ),
    );
    expect(forged).toMatch(/atom_events_decision_is_human/);

    // An agent may still propose — that is what `propose` and the extractor are
    // for, and a check that refused it would break the write path entirely.
    await withActor(data.orgA, data.agentA, (db) =>
      db.execute(
        sql`insert into atom_events (org_id, atom_id, event, actor_id)
            values (${data.orgA}, ${provisional}, 'proposed', ${data.agentA})`,
      ),
    );

    expect((await eventsOf(provisional)).length).toBe(2);
  });
});

/**
 * Runs a write that must be refused and returns what the database said.
 *
 * Drizzle wraps a driver error in one whose message is the SQL it sent and
 * hangs the database's own message off `cause`. Matching the wrapper would pass
 * for any failure at all — a typo in the fixture included — so the assertion
 * has to reach the cause and name the constraint.
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

describe("what the atom_events checks refuse", () => {
  const insert = (event: string, reason: string | null, note: string | null) =>
    withActor(data.orgA, data.humanA, async (db) => {
      const atomId = await provisionalAtom();
      return db.execute(
        sql`insert into atom_events (org_id, atom_id, event, actor_id, reason, reason_note)
            values (${data.orgA}, ${atomId}, ${sql.raw(`'${event}'`)}, ${data.humanA},
                    ${reason}, ${note})`,
      );
    });

  it("refuses a reason on an event that is not a rejection", async () => {
    // `atom_events_reason_only_on_reject`. The vocabulary is a rejection
    // vocabulary — it is the labelled corpus extraction precision is measured
    // with — and a `ratified` row carrying `not_true` would poison exactly that
    // measurement.
    expect(await refusal(() => insert("ratified", "not_true", null))).toMatch(
      /atom_events_reason_only_on_reject/,
    );
    expect(await refusal(() => insert("retired", null, "why it went"))).toMatch(
      /atom_events_reason_only_on_reject/,
    );
  });

  it("bounds the free-text note at 280 characters and refuses a blank one", async () => {
    // The only free-text field on this path, and `docs/13-threat-model.md`
    // still has "is a length cap sufficient, or does free text have no place
    // here at all" open against it. Until that closes, the cap is the answer,
    // so the cap is tested at its edge rather than near it.
    expect(
      await refusal(() => insert("rejected", null, "x".repeat(281))),
    ).toMatch(/atom_events_reason_note_shape/);
    expect(await refusal(() => insert("rejected", null, "   "))).toMatch(
      /atom_events_reason_note_shape/,
    );
    await expect(
      insert("rejected", null, "x".repeat(280)),
    ).resolves.toBeDefined();
  });

  it("accepts exactly 280 characters through rejectAtom itself", async () => {
    const atomId = await provisionalAtom();
    const note = "x".repeat(280);

    const rejected = await withActor(data.orgA, data.humanA, (db) =>
      rejectAtom(db, data.orgA, data.humanA, atomId, "not_true", note),
    );

    expect(rejected?.status).toBe("rejected");
    expect((await eventsOf(atomId))[1]?.reason_note).toBe(note);
  });
});

describe("a retired atom stops being served", () => {
  /**
   * Asserted rather than assumed.
   *
   * `retrieval.ts` filters on `a."status" = 'canonical'`, so `retired` drops
   * out of every generator by construction — but "by construction" is the claim
   * being made, and the fifth status was added to the enum after that filter
   * was written. A status the filter had been written to enumerate rather than
   * to narrow would have let retired atoms keep being served.
   */
  it("disappears from retrieval the moment it is retired", async () => {
    const statement = "retirement marker zebra quorum";
    const atomId = await canonicalAtom(statement);

    const found = () =>
      withActor(data.orgA, data.humanA, async (db) => {
        await setRetrievalGucs(db, { efSearch: 40, iterativeScan: true });
        return retrieveCandidates(db, {
          projectId: data.projectA,
          generators: ["lexical"],
          queryEmbedding: null,
          lexicalQuery: statement,
          trigramQuery: null,
          documentId: null,
          sectionId: null,
          perGeneratorLimit: 50,
          fusedLimit: 200,
        });
      });

    const before = await found();
    expect(before.candidates.map((c) => c.atomId)).toContain(atomId);

    await withActor(data.orgA, data.humanA, (db) =>
      retireAtom(db, data.orgA, data.humanA, atomId),
    );

    const after = await found();
    expect(after.candidates.map((c) => c.atomId)).not.toContain(atomId);
  });
});

describe("ratifyAtom with supersedes", () => {
  it("moves both atoms and writes both events in one transaction", async () => {
    const incumbent = await canonicalAtom("the old rule");
    const candidate = await provisionalAtom("the new rule");

    const ratified = await withActor(data.orgA, data.humanA, (db) =>
      ratifyAtom(db, data.orgA, data.humanA, candidate, incumbent),
    );

    expect(ratified?.status).toBe("canonical");
    expect(await statusOf(incumbent)).toBe("superseded");
    expect(await supersededByOf(incumbent)).toBe(candidate);

    // Exactly two events, and the same human on both halves of one decision.
    const candidateEvents = await eventsOf(candidate);
    const incumbentEvents = await eventsOf(incumbent);
    expect(candidateEvents.map((e) => e.event)).toEqual([
      "proposed",
      "ratified",
    ]);
    expect(incumbentEvents.map((e) => e.event)).toEqual([
      "proposed",
      "ratified",
      "superseded",
    ]);
    expect(incumbentEvents[2]?.actor_id).toBe(data.humanA);

    // One canonical atom left out of the pair. Two would be the state the whole
    // deduplication pass exists to prevent.
    const pair = [candidate, incumbent];
    const statuses = await Promise.all(pair.map(statusOf));
    expect(statuses.filter((s) => s === "canonical").length).toBe(1);
  });

  /**
   * The atomicity test, and the most important one in this file.
   *
   * The candidate's promotion is written before the incumbent is even looked
   * at, so a supersede that failed without rolling back would leave a *newly
   * canonical* atom beside an incumbent that never moved — two canonical atoms
   * making contradictory claims, with retrieval free to serve whichever it
   * ranked higher. Asserting only that the call threw would pass against
   * exactly that bug.
   */
  it("rolls the candidate back when the incumbent is not canonical", async () => {
    const incumbent = await provisionalAtom("never ratified");
    const candidate = await provisionalAtom("the new rule");

    await expect(
      withActor(data.orgA, data.humanA, (db) =>
        ratifyAtom(db, data.orgA, data.humanA, candidate, incumbent),
      ),
    ).rejects.toThrow(/not a canonical atom/);

    expect(await statusOf(candidate)).toBe("provisional");
    expect(await statusOf(incumbent)).toBe("provisional");
    expect(await supersededByOf(incumbent)).toBeNull();

    // The ledger too: `atom_events` is append-only by grant, so an entry
    // written inside a rolled-back transaction is one no repair could remove.
    expect((await eventsOf(candidate)).map((e) => e.event)).toEqual([
      "proposed",
    ]);
    expect((await eventsOf(incumbent)).map((e) => e.event)).toEqual([
      "proposed",
    ]);
  });

  it("refuses an incumbent in another project of the same org", async () => {
    const candidate = await provisionalAtom("the new rule");

    // Visible to this tenant and canonical, so only `project_id` stands between
    // the two. Without that predicate one project's reviewer could withdraw
    // knowledge from a project they were never looking at.
    await expect(
      withActor(data.orgA, data.humanA, (db) =>
        ratifyAtom(db, data.orgA, data.humanA, candidate, otherProject.atom),
      ),
    ).rejects.toThrow(/not a canonical atom in the same project/);

    expect(await statusOf(candidate)).toBe("provisional");
    expect(await statusOf(otherProject.atom)).toBe("canonical");
  });

  it("refuses to make an atom its own predecessor", async () => {
    const candidate = await provisionalAtom("the new rule");

    // The candidate is canonical by the time the incumbent is matched, so
    // without `ne(id, atomId)` it would match itself and be written as its own
    // predecessor — superseded and canonical in the same row's history.
    await expect(
      withActor(data.orgA, data.humanA, (db) =>
        ratifyAtom(db, data.orgA, data.humanA, candidate, candidate),
      ),
    ).rejects.toThrow(/not a canonical atom/);

    expect(await statusOf(candidate)).toBe("provisional");
  });
});

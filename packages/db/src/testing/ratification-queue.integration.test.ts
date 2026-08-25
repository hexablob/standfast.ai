import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import { pageOf } from "../pagination.js";
import {
  listQueue,
  queueStats,
  ratificationThroughput,
} from "../repositories/ratification.js";
import { adminUrl, ensureTestRole, type Seed, seed } from "./harness.js";

/**
 * Phase 4a — the ratification queue, and the number it produces.
 *
 * `docs/15-ratification.md` fixes the ordering and one hard rule about what
 * filtering may not touch; `docs/14-roadmap.md` criterion 2 fixes the metric.
 * Both are the kind of thing that looks right in a code review and is wrong in
 * production, because the failures are invisible: an order that is not total
 * makes paging drop rows without an error, and a backlog computed over a filter
 * reports health while the queue ages behind it.
 *
 * Every read runs through the unprivileged role under RLS, the way production
 * reaches the database. Fixtures are written by the owner, because a
 * cross-tenant assertion needs a real row on the far side of the boundary.
 */

let data: Seed;
const originalUrl = process.env["DATABASE_URL"];

/**
 * The body every fixture section carries, and the only text a fixture quote may
 * come from.
 *
 * `atoms_verify_quote_insert` compares `source_quote` against the substring
 * `source_span` names, so the spans are derived from this string rather than
 * counted by hand — a miscount would fail exactly like a broken trigger.
 */
const BODY = "One. Two. Three. Four.";

function spanOf(quote: string): string {
  const start = BODY.indexOf(quote);
  if (start < 0) {
    throw new Error(`fixture quote is not in the body: ${quote}`);
  }
  return `[${start},${start + quote.length})`;
}

/** Four quotes with four distinct span lower bounds: 0, 5, 10 and 17. */
const ONE = "One.";
const TWO = "Two.";
const THREE = "Three.";
const FOUR = "Four.";

type Fixture = {
  projectId: string;
  /** `docs/aaa.md`, two sections. */
  docFirst: string;
  s1: string;
  s2: string;
  /** `docs/zzz.md`, one section — sorts after `docFirst` by path. */
  docLast: string;
  s3: string;
};

/** The provisional atoms of the ordering fixture, by name. */
const q: Record<string, string> = {};

let queueProject = "";
let throughputProject = "";
let undecidedProject = "";
let otherOrgProject = "";

/**
 * A superuser connection.
 *
 * `adminUrl` reads `DATABASE_URL`, which this suite repoints at the
 * unprivileged role, so the owner's URL is the value captured before the swap.
 */
async function owner(): Promise<Client> {
  const client = new Client({ connectionString: originalUrl ?? adminUrl() });
  await client.connect();
  return client;
}

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const db = await owner();
  try {
    // One transaction, because `now()` is transaction-start time in Postgres
    // and the ties this suite is about are exactly that: many atoms inserted by
    // one extraction run under a single `now()`. Two transactions would produce
    // timestamps microseconds apart and the tie-break would never be reached.
    await db.query("begin");

    const one = async (statement: string, values: unknown[]): Promise<string> =>
      (await db.query<{ id: string }>(statement, values)).rows[0]?.id ?? "";

    const fixture = async (orgId: string, slug: string): Promise<Fixture> => {
      const projectId = await one(
        "insert into projects (org_id, name, slug) values ($1, $2, $2) returning id",
        [orgId, slug],
      );
      const document = async (path: string): Promise<string> =>
        one(
          `insert into documents (org_id, project_id, path, body, content_hash)
           values ($1, $2, $3, $4, $3) returning id`,
          [orgId, projectId, `${slug}/${path}`, BODY],
        );
      const section = async (
        documentId: string,
        ordinal: number,
      ): Promise<string> =>
        one(
          `insert into document_sections (org_id, document_id, ordinal, heading_path, body, section_hash)
           values ($1, $2, $3, ARRAY['H'], $4, $5) returning id`,
          [orgId, documentId, ordinal, BODY, `${documentId}:${ordinal}`],
        );

      const docFirst = await document("docs/aaa.md");
      const docLast = await document("docs/zzz.md");
      return {
        projectId,
        docFirst,
        s1: await section(docFirst, 0),
        s2: await section(docFirst, 1),
        docLast,
        s3: await section(docLast, 0),
      };
    };

    /**
     * One atom, its arrival event, and — when it has been decided — the event
     * that decided it.
     *
     * `agedSeconds` is applied against the database's `now()` rather than this
     * process's clock, so the ages the metric reads are the ages the fixture
     * intended even with the two machines a real deployment has.
     */
    const atom = async (input: {
      orgId: string;
      projectId: string;
      documentId: string;
      sectionId: string;
      quote: string;
      kind?: "decision" | "convention" | "constraint";
      status?:
        | "provisional"
        | "canonical"
        | "rejected"
        | "superseded"
        | "retired";
      agedSeconds: number;
      decision?: "ratified" | "rejected" | "superseded" | "retired";
      decidedAfterSeconds?: number;
    }): Promise<string> => {
      const status = input.status ?? "provisional";
      const ratified = status === "canonical";
      // `atom_events_actor_in_org_fk` refuses an actor from the next org over,
      // which is the constraint under test elsewhere and a fixture bug here.
      const proposer =
        input.orgId === data.orgB ? data.extractorB : data.agentA;
      const id = await one(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind, status,
            source_quote, source_span, created_at, ratified_by, ratified_by_kind, ratified_at)
         values ($1, $2, $3, $4, $5, $6, $7, $5, $8,
                 now() - make_interval(secs => $9::float8),
                 $10, $11, $12)
         returning id`,
        [
          input.orgId,
          input.projectId,
          input.documentId,
          input.sectionId,
          input.quote,
          input.kind ?? "convention",
          status,
          spanOf(input.quote),
          input.agedSeconds,
          ratified ? data.humanA : null,
          ratified ? "human" : null,
          ratified ? new Date() : null,
        ],
      );

      await db.query(
        `insert into atom_events (org_id, atom_id, event, actor_id, at)
         values ($1, $2, 'proposed', $3, now() - make_interval(secs => $4::float8))`,
        [input.orgId, id, proposer, input.agedSeconds],
      );

      if (input.decision) {
        await db.query(
          `insert into atom_events (org_id, atom_id, event, actor_id, at)
           values ($1, $2, $3, $4, now() - make_interval(secs => $5::float8))`,
          [
            input.orgId,
            id,
            input.decision,
            data.humanA,
            input.agedSeconds - (input.decidedAfterSeconds ?? 0),
          ],
        );
      }

      return id;
    };

    // ---- the ordering fixture -------------------------------------------
    //
    // Six of the eight provisional atoms arrive at the same instant, which is
    // the ordinary case rather than a contrivance. Their span lower bounds are
    // chosen so that ordering on arrival and span alone — the obvious wrong
    // answer — interleaves the three sections: 0, 5, 5, 10, 10, 17.
    const fx = await fixture(data.orgA, "queue");
    queueProject = fx.projectId;

    const provisional = (
      documentId: string,
      sectionId: string,
      quote: string,
      agedSeconds: number,
      kind?: "decision" | "convention" | "constraint",
    ) =>
      atom({
        orgId: data.orgA,
        projectId: fx.projectId,
        documentId,
        sectionId,
        quote,
        agedSeconds,
        ...(kind ? { kind } : {}),
      });

    q["early"] = await provisional(fx.docLast, fx.s3, ONE, 900);
    q["a2"] = await provisional(fx.docFirst, fx.s1, ONE, 600);
    q["a1"] = await provisional(fx.docFirst, fx.s1, THREE, 600);
    q["b1"] = await provisional(fx.docFirst, fx.s2, TWO, 600);
    q["b2"] = await provisional(fx.docFirst, fx.s2, FOUR, 600);
    q["z1"] = await provisional(fx.docLast, fx.s3, TWO, 600, "constraint");
    q["z2"] = await provisional(fx.docLast, fx.s3, THREE, 600);
    q["late"] = await provisional(fx.docFirst, fx.s1, FOUR, 300);

    // One of each decided status, all older than the head of the queue, so a
    // query that leaked them would change both the order and the age.
    for (const [status, decision] of [
      ["canonical", "ratified"],
      ["rejected", "rejected"],
      ["superseded", "superseded"],
      ["retired", "retired"],
    ] as const) {
      await atom({
        orgId: data.orgA,
        projectId: fx.projectId,
        documentId: fx.docFirst,
        sectionId: fx.s1,
        quote: TWO,
        status,
        decision,
        agedSeconds: 1200,
        decidedAfterSeconds: 60,
      });
    }

    // ---- the throughput fixture -----------------------------------------
    //
    // Five decisions at 1, 1, 1, 1 and 1000 seconds. The mean is 200.8 and the
    // median is 1, which is the whole point: one atom that sat for a fortnight
    // must not describe the review everyone else got.
    const tf = await fixture(data.orgA, "throughput");
    throughputProject = tf.projectId;

    const decided = async (
      gap: number,
      status: "canonical" | "rejected" | "superseded" | "retired",
      decision: "ratified" | "rejected" | "superseded" | "retired",
    ) =>
      atom({
        orgId: data.orgA,
        projectId: tf.projectId,
        documentId: tf.docFirst,
        sectionId: tf.s1,
        quote: ONE,
        status,
        decision,
        agedSeconds: 5000,
        decidedAfterSeconds: gap,
      });

    await decided(1, "canonical", "ratified");
    await decided(1, "canonical", "ratified");
    await decided(1, "rejected", "rejected");
    await decided(1, "superseded", "superseded");
    await decided(1000, "retired", "retired");

    // Four still waiting, at four ages, so the share can be asked for at any
    // threshold and answer differently each time.
    const waiting = (quote: string, agedSeconds: number) =>
      atom({
        orgId: data.orgA,
        projectId: tf.projectId,
        documentId: tf.docLast,
        sectionId: tf.s3,
        quote,
        agedSeconds,
      });
    await waiting(ONE, 10);
    await waiting(TWO, 20);
    await waiting(THREE, 5000);
    await waiting(FOUR, 6000);

    // ---- nothing has been decided here ----------------------------------
    const uf = await fixture(data.orgA, "undecided");
    undecidedProject = uf.projectId;
    await atom({
      orgId: data.orgA,
      projectId: uf.projectId,
      documentId: uf.docFirst,
      sectionId: uf.s1,
      quote: ONE,
      agedSeconds: 42,
    });

    // ---- the next org over ----------------------------------------------
    const of = await fixture(data.orgB, "other-org");
    otherOrgProject = of.projectId;
    for (const quote of [ONE, TWO]) {
      await atom({
        orgId: data.orgB,
        projectId: of.projectId,
        documentId: of.docFirst,
        sectionId: of.s1,
        quote,
        agedSeconds: 99_999,
      });
    }

    await db.query("commit");
  } finally {
    await db.end();
  }

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  if (originalUrl) {
    process.env["DATABASE_URL"] = originalUrl;
  }
});

const asHuman = <T>(fn: Parameters<typeof withActor<T>>[2]): Promise<T> =>
  withActor(data.orgA, data.humanA, fn);

/** The full queue in one page, as ids, which is what every order assertion is. */
const ids = async (
  projectId: string,
  filters?: Parameters<typeof listQueue>[3],
): Promise<string[]> => {
  const page = await asHuman((db) =>
    listQueue(db, projectId, pageOf({ limit: 200 }), filters),
  );
  return page.items.map((item) => item.id);
};

describe("listQueue ordering", () => {
  it("is FIFO on the proposed event, oldest first", async () => {
    const order = await ids(queueProject);
    expect(order[0]).toBe(q["early"]);
    expect(order.at(-1)).toBe(q["late"]);
  });

  it("groups a section's atoms consecutively inside an arrival tie", async () => {
    const order = await ids(queueProject);

    // The exact sequence, not a property of it. Ordering on arrival and span
    // alone would give 0, 5, 5, 10, 10, 17 — the three sections interleaved —
    // and every weaker assertion here passed against that.
    expect(order).toEqual([
      q["early"],
      q["a2"],
      q["a1"],
      q["b1"],
      q["b2"],
      q["z1"],
      q["z2"],
      q["late"],
    ]);

    // Said again as the property the ordering exists for: one quote context is
    // read once, not once per atom.
    const sectionOf = new Map(
      Object.entries({
        [q["a2"] ?? ""]: "s1",
        [q["a1"] ?? ""]: "s1",
        [q["b1"] ?? ""]: "s2",
        [q["b2"] ?? ""]: "s2",
        [q["z1"] ?? ""]: "s3",
        [q["z2"] ?? ""]: "s3",
      }),
    );
    const runs = order
      .map((id) => sectionOf.get(id))
      .filter((s): s is string => s !== undefined)
      .filter((section, i, all) => section !== all[i - 1]);
    expect(runs).toEqual(["s1", "s2", "s3"]);
  });

  it("is total: two identical calls return one sequence", async () => {
    const first = await ids(queueProject);
    const second = await ids(queueProject);
    expect(second).toEqual(first);
    expect(first).toHaveLength(8);
  });

  it("carries what the reviewer has to read, in full", async () => {
    const page = await asHuman((db) =>
      listQueue(db, queueProject, pageOf({ limit: 1 })),
    );
    const item = page.items[0];
    expect(item?.id).toBe(q["early"]);
    expect(item?.documentPath).toBe("queue/docs/zzz.md");
    expect(item?.sectionHeadingPath).toEqual(["H"]);
    expect(item?.sectionOrdinal).toBe(0);
    // The section arrives whole. `docs/15-ratification.md` refuses provenance
    // reached by an extra click, and a truncated body is that click.
    expect(item?.sectionBody).toBe(BODY);
    expect(item?.sourceQuote).toBe(ONE);
    expect(item?.sourceSpan).toBe(spanOf(ONE));
    expect(item?.proposedById).toBe(data.agentA);
    expect(item?.proposedByKind).toBe("agent");
  });
});

describe("listQueue membership", () => {
  it("shows the provisional atoms and no decided one", async () => {
    const page = await asHuman((db) =>
      listQueue(db, queueProject, pageOf({ limit: 200 })),
    );
    expect(page.total).toBe(8);
    expect(page.items.every((item) => item.status === "provisional")).toBe(
      true,
    );

    // The decided atoms are genuinely there — so the filter above is excluding
    // them rather than the fixture having failed to write them.
    const all = await asHuman((db) =>
      db.execute(
        `select count(*)::int as n from atoms where status <> 'provisional'`,
      ),
    );
    expect(Number(all.rows[0]?.["n"])).toBeGreaterThanOrEqual(4);
  });

  it("never reaches another org's queue", async () => {
    const page = await asHuman((db) =>
      listQueue(db, otherOrgProject, pageOf({ limit: 200 })),
    );
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);

    // And the rows exist, which is what makes the emptiness above a boundary
    // rather than an empty fixture.
    const stats = await withActor(data.orgB, data.extractorB, (db) =>
      queueStats(db, otherOrgProject),
    );
    expect(stats.backlog).toBe(2);
  });
});

describe("listQueue pagination", () => {
  it("returns disjoint pages and one total", async () => {
    const pages = await Promise.all(
      [0, 3, 6].map((offset) =>
        asHuman((db) =>
          listQueue(db, queueProject, pageOf({ limit: 3, offset })),
        ),
      ),
    );

    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 2]);
    expect(pages.every((p) => p.total === 8)).toBe(true);
    expect(pages.map((p) => p.truncated)).toEqual([true, true, false]);

    const walked = pages.flatMap((p) => p.items.map((i) => i.id));
    expect(new Set(walked).size).toBe(8);
    expect(walked).toEqual(await ids(queueProject));
  });
});

describe("filtering, which is not re-sorting", () => {
  it("removes rows and leaves the order alone", async () => {
    const everything = await ids(queueProject);
    const byDocument = await ids(queueProject, {
      documentId: (
        await asHuman((db) => listQueue(db, queueProject, pageOf({ limit: 1 })))
      ).items[0]?.documentId as string,
    });

    expect(byDocument).toEqual([q["early"], q["z1"], q["z2"]]);
    // A subsequence of the unfiltered queue, in the unfiltered order.
    expect(byDocument).toEqual(
      everything.filter((id) => byDocument.includes(id)),
    );
  });

  it("filters by kind", async () => {
    expect(await ids(queueProject, { kind: "constraint" })).toEqual([q["z1"]]);
  });

  /**
   * The hard rule from `docs/15-ratification.md`, and the most valuable
   * assertion in this file.
   *
   * Queue age and backlog are computed over the *unfiltered* queue. Otherwise
   * the reviewer who filters to `convention` sees a healthy queue while the
   * `constraint` backlog ages behind it, and the metric flatters exactly the
   * behaviour it exists to catch. `queueStats` takes no filter argument at all,
   * which is the only version of the rule a caller cannot get wrong — so what
   * this test proves is that narrowing the queue to a single row leaves the
   * reported backlog and age untouched.
   */
  it("does not change what queueStats reports", async () => {
    const before = await asHuman((db) => queueStats(db, queueProject));

    const narrowed = await asHuman((db) =>
      listQueue(db, queueProject, pageOf(), { kind: "constraint" }),
    );
    expect(narrowed.total).toBe(1);

    const after = await asHuman((db) => queueStats(db, queueProject));

    expect(after.backlog).toBe(8);
    expect(before.backlog).toBe(8);
    // The head of the queue is the age, and the head is `early` at 900s — the
    // filtered view's only row arrived 300 seconds later.
    expect(after.queueAgeSeconds ?? 0).toBeGreaterThan(880);
    expect(after.oldestProposedAt).toEqual(before.oldestProposedAt);
  });
});

describe("ratificationThroughput", () => {
  it("reports the median, not the mean", async () => {
    const result = await asHuman((db) =>
      ratificationThroughput(db, throughputProject, 3600),
    );

    // Gaps of 1, 1, 1, 1 and 1000 seconds: mean 200.8, median 1.
    expect(result.decided).toBe(5);
    expect(result.medianSecondsToDecision).not.toBeNull();
    expect(result.medianSecondsToDecision ?? 0).toBeLessThan(2);
    expect(result.medianSecondsToDecision ?? 0).toBeGreaterThan(0.5);
  });

  it("counts a decision of any kind, and an undecided atom as neither", async () => {
    const result = await asHuman((db) =>
      ratificationThroughput(db, throughputProject, 3600),
    );
    // Two ratified, one rejected, one superseded, one retired. The four
    // provisional atoms are backlog and contribute no data point.
    expect(result.decided).toBe(5);
    expect(result.backlog).toBe(4);
  });

  it("returns null when nothing has been decided", async () => {
    const result = await asHuman((db) =>
      ratificationThroughput(db, undecidedProject, 3600),
    );
    expect(result.decided).toBe(0);
    // Not zero. Zero would read as "instant review", which is the one thing
    // this metric must never say about work nobody has done.
    expect(result.medianSecondsToDecision).toBeNull();
    expect(result.backlog).toBe(1);
  });

  it("computes the backlog share against the caller's threshold", async () => {
    const ages = [10, 20, 5000, 6000];

    const anHour = await asHuman((db) =>
      ratificationThroughput(db, throughputProject, 3600),
    );
    expect(anHour.backlogOlderThan).toBe(2);
    expect(anHour.backlogShareOlderThan).toBe(0.5);

    const aSecond = await asHuman((db) =>
      ratificationThroughput(db, throughputProject, 1),
    );
    expect(aSecond.backlogOlderThan).toBe(4);
    expect(aSecond.backlogShareOlderThan).toBe(1);

    const aYear = await asHuman((db) =>
      ratificationThroughput(db, throughputProject, 31_536_000),
    );
    expect(aYear.backlogOlderThan).toBe(0);
    expect(aYear.backlogShareOlderThan).toBe(0);

    // The raw distribution, so a caller can answer for a threshold nobody has
    // chosen yet — which is the state `docs/14-roadmap.md` leaves this bar in.
    expect(anHour.backlogAgesSeconds).toHaveLength(4);
    expect(
      anHour.backlogAgesSeconds.map((age) => Math.round(age / 10) * 10),
    ).toEqual(ages.map((age) => Math.round(age / 10) * 10));
  });

  it("has no default threshold", async () => {
    await asHuman(async (db) => {
      // @ts-expect-error the age is required. `docs/14-roadmap.md` carries this
      // bar as an open decision, and a default would be the invented threshold
      // `docs/02-principles.md` (10) forbids.
      await ratificationThroughput(db, throughputProject);
    });
  });
});

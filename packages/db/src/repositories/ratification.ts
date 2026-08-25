import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import { atoms, documentSections, documents } from "../schema/knowledge.js";
import { actors } from "../schema/tenancy.js";

/**
 * Phase 4a — the queue a human works through, and the number that says whether
 * they are keeping up.
 *
 * `docs/15-ratification.md` owns both. Nothing here takes an `orgId`: RLS reads
 * it from the `standfast.org_id` GUC, and a parameter would be a second place
 * the tenancy boundary is decided — two places that can disagree.
 */

/**
 * The atom's arrival, which is the `proposed` event and not `atoms.created_at`.
 *
 * `docs/15-ratification.md` orders the queue strictly FIFO on this column, and
 * the whole point is that arrival is an *event* — the same table the throughput
 * metric reads, so the queue a reviewer sees and the number a dashboard reports
 * cannot drift apart.
 *
 * `min()` rather than a plain join because `atom_events` carries no unique
 * constraint on `(atom_id, event)`; a duplicated `proposed` row would otherwise
 * duplicate the atom in the queue rather than move it.
 *
 * The COALESCE is not a second ordering key. `createAtom` inserts the atom and
 * its `proposed` event in one transaction, and Postgres `now()` is
 * transaction-start time, so for every row the write path produces the two
 * values are equal to the microsecond. What it buys is that a provisional atom
 * with no arrival event can never silently vanish from the queue — an atom
 * dropped from review is the one failure this surface must not have.
 */
const arrivedAt = sql<Date>`coalesce((
  select min(e.at) from atom_events e
  where e.atom_id = ${atoms.id} and e.event = 'proposed'
), ${atoms.createdAt})`;

/**
 * What the reviewer is shown, in one row.
 *
 * `docs/15-ratification.md` fixes the reading order — where it came from, then
 * the quote inside its section, then the statement — and forbids provenance
 * that is reachable by an extra click. A second round trip is a click, so
 * everything that order calls for is on the row: the section's `body` arrives
 * **whole and untruncated**, because "the quote, verbatim, inside its
 * surrounding section" is the point, and a span can be quoted exactly and still
 * mean something else once the sentence before it is visible.
 */
export type QueueItem = {
  readonly id: string;
  readonly kind: (typeof atoms.$inferSelect)["kind"];
  readonly statement: string;
  readonly sourceQuote: string;
  readonly sourceSpan: string;
  readonly status: (typeof atoms.$inferSelect)["status"];
  readonly createdAt: Date;
  /** The `proposed` event, and the key the queue is ordered on. */
  readonly proposedAt: Date;
  readonly proposedById: string | null;
  readonly proposedByKind: (typeof actors.$inferSelect)["kind"] | null;
  readonly proposedByName: string | null;
  readonly documentId: string;
  readonly documentPath: string;
  readonly sectionId: string;
  readonly sectionOrdinal: number;
  readonly sectionHeadingPath: string[];
  /** Verbatim and complete. Never abridged here — see the type's comment. */
  readonly sectionBody: string;
};

/**
 * The filters `docs/15-ratification.md` permits, and only those.
 *
 * Project is the required argument above. `flagged` is deliberately absent:
 * `docs/13-threat-model.md` records that the flagging heuristic does not exist,
 * and a filter over an empty predicate is a control that looks like it works.
 *
 * A filter is an explicit act by a human, visible while it is on. Re-sorting is
 * invisible and permanent, so nothing here reaches the ORDER BY — the filtered
 * queue is the same queue with rows removed, in the same order.
 */
export type QueueFilters = {
  readonly kind?: (typeof atoms.$inferSelect)["kind"];
  readonly documentId?: string;
};

/**
 * The provisional queue, oldest first.
 *
 * ORDER BY arrival, then `documents.path`, then `document_sections.ordinal`,
 * then the lower bound of `source_span`, then `atoms.id`.
 *
 * Ties on arrival are the ordinary case, not the exception — one extraction run
 * inserts many rows in one transaction under a single `now()` — so the
 * tie-break is doing the real work, and it is chosen rather than incidental:
 * atoms from one section share one quote context, so ordering by section and
 * then by position within it shows them consecutively and the reviewer reads
 * that section once instead of *n* times.
 *
 * Every key is total. `atoms.id` at the end is not decoration: an order that
 * varies between two identical calls makes offset paging return overlapping
 * pages and skip rows, which is worse than no paging at all. Every column ahead
 * of it is NOT NULL, and `arrivedAt` coalesces, so no key can compare null.
 */
export async function listQueue(
  db: Db,
  projectId: string,
  page: Page,
  filters?: QueueFilters,
): Promise<Paged<QueueItem>> {
  const rows = await db
    .select({
      id: atoms.id,
      kind: atoms.kind,
      statement: atoms.statement,
      sourceQuote: atoms.sourceQuote,
      sourceSpan: atoms.sourceSpan,
      status: atoms.status,
      createdAt: atoms.createdAt,
      proposedAt: arrivedAt,
      proposedById: actors.id,
      proposedByKind: actors.kind,
      proposedByName: actors.displayName,
      documentId: documents.id,
      documentPath: documents.path,
      sectionId: documentSections.id,
      sectionOrdinal: documentSections.ordinal,
      sectionHeadingPath: documentSections.headingPath,
      sectionBody: documentSections.body,
      pageTotal: PAGE_TOTAL,
    })
    .from(atoms)
    .innerJoin(documents, eq(documents.id, atoms.documentId))
    .innerJoin(documentSections, eq(documentSections.id, atoms.sectionId))
    // LEFT, because the proposer is provenance and not a filter. An atom whose
    // proposing actor was removed still has to be reviewed, and an inner join
    // would answer that by hiding it.
    .leftJoin(
      actors,
      sql`${actors.id} = (
        select e.actor_id from atom_events e
        where e.atom_id = ${atoms.id} and e.event = 'proposed'
        order by e.at asc, e.id asc limit 1
      )`,
    )
    .where(
      and(
        eq(atoms.projectId, projectId),
        // The queue is the provisional atoms. `canonical`, `rejected`,
        // `superseded` and `retired` have all been decided; showing one would
        // invite a second decision on a settled row.
        eq(atoms.status, "provisional"),
        filters?.kind ? eq(atoms.kind, filters.kind) : undefined,
        filters?.documentId
          ? eq(atoms.documentId, filters.documentId)
          : undefined,
      ),
    )
    .orderBy(
      asc(arrivedAt),
      asc(documents.path),
      asc(documentSections.ordinal),
      sql`lower(${atoms.sourceSpan}) asc`,
      asc(atoms.id),
    )
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

export type QueueStats = {
  /** Provisional atoms in the project. Never the filtered count. */
  readonly backlog: number;
  /** The head of the queue, which is also the oldest thing waiting. */
  readonly oldestProposedAt: Date | null;
  /** Its age, measured by the database's clock rather than the caller's. */
  readonly queueAgeSeconds: number | null;
};

/**
 * Backlog size and queue age.
 *
 * **Takes no filters, and that is the hard rule rather than an omission.**
 * `docs/15-ratification.md`: queue age and backlog are computed over the
 * unfiltered queue, or the reviewer who filters to `convention` sees a healthy
 * queue while the `constraint` backlog ages behind it — the metric flattering
 * exactly the behaviour it exists to catch. Refusing the parameter is the only
 * version of that rule a caller cannot get wrong.
 *
 * The age is the head of the queue by construction: FIFO means the oldest
 * arrival is the row the reviewer is looking at, so the number on the dashboard
 * and the item on screen cannot come apart.
 */
export async function queueStats(
  db: Db,
  projectId: string,
): Promise<QueueStats> {
  const [row] = await db
    .select({
      backlog: sql<number>`count(*)::int`,
      // Typed as the string it actually is, and converted below.
      //
      // `sql<Date | null>` would be a type *assertion*, not a conversion: the
      // node-postgres driver hands `timestamptz` back as a raw string and
      // relies on a per-column `mapFromDriverValue` to build a Date, which a
      // bare `sql` expression never gets. Declaring `Date` there compiles, and
      // then `.toISOString()` throws at the first caller with a non-empty
      // backlog — which is exactly what it did.
      oldestProposedAt: sql<string | null>`min(${arrivedAt})`,
      queueAgeSeconds: sql<
        number | null
      >`extract(epoch from (now() - min(${arrivedAt})))::float8`,
    })
    .from(atoms)
    .where(
      and(eq(atoms.projectId, projectId), eq(atoms.status, "provisional")),
    );

  return {
    backlog: row?.backlog ?? 0,
    oldestProposedAt: row?.oldestProposedAt
      ? new Date(row.oldestProposedAt)
      : null,
    queueAgeSeconds: row?.queueAgeSeconds ?? null,
  };
}

export type Throughput = {
  /** Atoms that reached a decision. The median's *n*, so it can be judged. */
  readonly decided: number;
  /**
   * Median seconds from `proposed` to the first decision, or `null` when
   * nothing has been decided. Never zero — see the function's comment.
   */
  readonly medianSecondsToDecision: number | null;
  /** Provisional atoms right now. */
  readonly backlog: number;
  /** How many of them are older than the age the caller chose. */
  readonly backlogOlderThan: number;
  /** That as a share, or `null` when there is no backlog to take a share of. */
  readonly backlogShareOlderThan: number | null;
  /**
   * Every provisional atom's age in seconds, ascending.
   *
   * Returned because the threshold is not chosen: with the distribution in
   * hand a caller can answer for any age without this function committing to
   * one. Bounded by the backlog, which is a list a human has to read anyway.
   */
  readonly backlogAgesSeconds: number[];
};

/**
 * Phase 4 exit criterion 2 (`docs/14-roadmap.md`): ratification throughput.
 *
 * A **decision** is `ratified`, `rejected`, `superseded` or `retired`. Skip
 * writes no event on purpose (`docs/15-ratification.md`), so an atom nobody has
 * decided is backlog, not a fast review — it contributes to the share below and
 * to nothing else.
 *
 * `percentile_cont(0.5)`, never `avg`. One atom that sat for three months moves
 * a mean by weeks and tells you nothing about the review a reviewer actually
 * does; the median is the number the metric is asking for.
 *
 * `null` for the median when nothing has been decided — which is what
 * `percentile_cont` returns over an empty set, so it is not special-cased.
 * Zero would read as "instant review", and a metric that reads best when no
 * work has happened is worse than no metric.
 *
 * `olderThanSeconds` is **required and has no default**. `docs/14-roadmap.md`
 * carries this bar as an open decision and owns it, and `docs/02-principles.md`
 * (10) forbids inventing a threshold before the corpus exists; a default here
 * would be that invention with a shorter argument. Seconds rather than a cutoff
 * instant so the comparison happens against the database's clock — the API and
 * Postgres are different machines, and NTP skew has already produced one
 * ordering bug in this schema.
 */
export async function ratificationThroughput(
  db: Db,
  projectId: string,
  olderThanSeconds: number,
): Promise<Throughput> {
  // One pass over the project's events, grouped per atom, rather than a
  // correlated subquery per atom: the median needs every decided atom anyway,
  // so there is no page to push the work behind.
  const decisions = await db.execute<{
    decided: number;
    median: number | null;
  }>(sql`
    select
      count(*)::int as decided,
      percentile_cont(0.5) within group (order by seconds)::float8 as median
    from (
      select extract(epoch from (
        min(e.at) filter (where e.event in ('ratified', 'rejected', 'superseded', 'retired'))
        - min(e.at) filter (where e.event = 'proposed')
      )) as seconds
      from atom_events e
      join atoms a on a.id = e.atom_id
      where a.project_id = ${projectId}
      group by e.atom_id
      having min(e.at) filter (where e.event = 'proposed') is not null
         and min(e.at) filter (where e.event in ('ratified', 'rejected', 'superseded', 'retired')) is not null
    ) t
  `);

  // The ages come back raw and the threshold is applied here, so the caller's
  // chosen age and the distribution it is applied to are the same numbers. The
  // subtraction is still Postgres's, against Postgres's `now()`.
  const ageSeconds = sql<number>`extract(epoch from (now() - ${arrivedAt}))::float8`;
  const ages = await db
    .select({ ageSeconds })
    .from(atoms)
    .where(and(eq(atoms.projectId, projectId), eq(atoms.status, "provisional")))
    .orderBy(asc(ageSeconds));

  const backlogAgesSeconds = ages.map((row) => Number(row.ageSeconds));
  const older = backlogAgesSeconds.filter(
    (age) => age > olderThanSeconds,
  ).length;
  const row = decisions.rows[0];

  return {
    decided: Number(row?.decided ?? 0),
    medianSecondsToDecision: row?.median == null ? null : Number(row.median),
    backlog: backlogAgesSeconds.length,
    backlogOlderThan: older,
    // 0/0 is not 0. An empty backlog has no share, and reporting one would be
    // the same lie as a zero median.
    backlogShareOlderThan: backlogAgesSeconds.length
      ? older / backlogAgesSeconds.length
      : null,
    backlogAgesSeconds,
  };
}

import type { EgressPurpose } from "@standfast/core";
import {
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  max,
  min,
  sum,
} from "drizzle-orm";
import type { Db } from "../client.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import { egressEvents } from "../schema/knowledge.js";

export type EgressEvent = typeof egressEvents.$inferSelect;

/**
 * One outbound call, described by its shape rather than its content.
 *
 * `inputChars` is the measurement `docs/13-threat-model.md` (*Egress*, rule 3)
 * needs and the most this record may ever hold. There is deliberately no field
 * for the prose itself, and adding one would have to survive a reviewer asking
 * why the disclosure log is now a second copy of the customer's documents.
 */
export type EgressCall = {
  readonly orgId: string;
  readonly projectId: string;
  readonly sectionId?: string | undefined;
  readonly purpose: EgressPurpose;
  /** The origin the allowlist admitted. */
  readonly destination: string;
  /** The version the allowlist pinned. */
  readonly model: string;
  readonly inputItems: number;
  readonly inputChars: number;
};

/**
 * Writes the record of a call that is about to be made.
 *
 * Called *before* the request, so the failure mode is a row for a call that
 * never connected rather than a call nobody can see. The caller does not catch
 * this: if the record cannot be written the request is not sent, which is the
 * only ordering that makes "what left" answerable rather than approximate.
 */
export async function recordEgress(db: Db, call: EgressCall): Promise<void> {
  await db.insert(egressEvents).values({
    orgId: call.orgId,
    projectId: call.projectId,
    sectionId: call.sectionId ?? null,
    purpose: call.purpose,
    destination: call.destination,
    model: call.model,
    inputItems: call.inputItems,
    inputChars: call.inputChars,
  });
}

/** Most recent first, because the question is nearly always "and lately?". */
export async function listEgress(
  db: Db,
  projectId: string,
  page: Page,
): Promise<Paged<EgressEvent>> {
  const rows = await db
    .select({ ...getTableColumns(egressEvents), pageTotal: PAGE_TOTAL })
    .from(egressEvents)
    .where(eq(egressEvents.projectId, projectId))
    .orderBy(desc(egressEvents.at), egressEvents.id)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

export type EgressSummaryRow = {
  purpose: EgressPurpose;
  destination: string;
  model: string;
  calls: number;
  items: number;
  chars: number;
  firstAt: Date;
  lastAt: Date;
};

/**
 * The answer to the question as it is actually asked: what left this project,
 * to whom, as which model, how much of it, and between when and when.
 *
 * Grouped by the triple the allowlist pins, so a deployment that changed model
 * version mid-quarter shows two rows rather than one averaged one — the point
 * of pinning is lost if the disclosure collapses the pin.
 */
export async function summarizeEgress(
  db: Db,
  projectId: string,
): Promise<EgressSummaryRow[]> {
  const rows = await db
    .select({
      purpose: egressEvents.purpose,
      destination: egressEvents.destination,
      model: egressEvents.model,
      calls: count(),
      items: sum(egressEvents.inputItems),
      chars: sum(egressEvents.inputChars),
      firstAt: min(egressEvents.at),
      lastAt: max(egressEvents.at),
    })
    .from(egressEvents)
    .where(eq(egressEvents.projectId, projectId))
    .groupBy(egressEvents.purpose, egressEvents.destination, egressEvents.model)
    .orderBy(asc(egressEvents.purpose), asc(egressEvents.model));

  // `sum` and `min`/`max` come back as strings and possibly null over an empty
  // group; the group cannot be empty here, and the coercion is where that is
  // stated rather than assumed.
  return rows.map((row) => ({
    purpose: row.purpose,
    destination: row.destination,
    model: row.model,
    calls: Number(row.calls),
    items: Number(row.items ?? 0),
    chars: Number(row.chars ?? 0),
    firstAt: row.firstAt as Date,
    lastAt: row.lastAt as Date,
  }));
}

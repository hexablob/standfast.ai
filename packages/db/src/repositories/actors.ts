import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { actors } from "../schema/tenancy.js";

/**
 * The system key of the actor extraction attributes its output to.
 *
 * One per org, `kind = 'agent'`, created with the org. It exists because
 * docs/05-extraction.md needs every extracted atom attributed to somebody and
 * declines both alternatives: a null actor breaks the append-only event log the
 * phase-4 throughput metric is computed from, and the pushing human's actor
 * attributes a model's output to a person.
 *
 * The guarantee that it cannot ratify anything is not granted here and is not
 * checked here. `actors` is unique on `(id, kind)` and `atoms` carries a
 * composite foreign key to `(id, 'human')`, so an actor created as an agent is
 * unrepresentable as a ratifier. The extractor inherits that rather than being
 * given an exception to it.
 */
export const EXTRACTOR_SYSTEM_KEY = "extractor";

export type Actor = typeof actors.$inferSelect;

/**
 * Creates the org's extractor actor if it does not have one, and returns its id.
 *
 * Idempotent, and called where an org is created — never from inside a job.
 * Minting identities lazily, under load, from the worker is how one org ends up
 * with two extractors after a race, and `atom_events` would then record the same
 * agent under two ids with no way to tell they were one.
 */
export async function ensureExtractorActor(
  db: Db,
  orgId: string,
): Promise<string> {
  const inserted = await db
    .insert(actors)
    .values({
      orgId,
      kind: "agent",
      displayName: "Extractor",
      systemKey: EXTRACTOR_SYSTEM_KEY,
    })
    .onConflictDoNothing({ target: [actors.orgId, actors.systemKey] })
    .returning({ id: actors.id });

  const existing = inserted[0]?.id;
  if (existing) return existing;

  return requireExtractorActor(db, orgId);
}

/**
 * Returns the org's extractor actor, or throws.
 *
 * Throws rather than creating, because the callers that matter are on the write
 * path of a document push: a missing extractor is a database that was not
 * migrated, and inventing one there would turn a loud setup error into a silent
 * second identity.
 */
export async function requireExtractorActor(
  db: Db,
  orgId: string,
): Promise<string> {
  const rows = await db
    .select({ id: actors.id })
    .from(actors)
    .where(
      and(
        eq(actors.orgId, orgId),
        eq(actors.systemKey, EXTRACTOR_SYSTEM_KEY),
        eq(actors.kind, "agent"),
      ),
    )
    .limit(1);

  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `org ${orgId} has no extractor actor. It is created with the org and backfilled by migration 0004; a database missing one has not been migrated.`,
    );
  }
  return id;
}

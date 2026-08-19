import {
  type Db,
  requireExtractorActor,
  type SectionExtractJob,
} from "@standfast/db";
import { sql } from "drizzle-orm";

/**
 * Every section of a project, in the order a rebuild must process them:
 * documents by path, then sections by ordinal.
 *
 * The order is part of the extractor version, not an implementation detail.
 * Deduplication is first-writer-wins, so a different order yields a different —
 * and equally correct — set of atoms. A running system does not care. An
 * evaluation harness would measure the difference as noise.
 */
export async function projectSectionsInOrder(
  db: Db,
  projectId: string,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select s.id
      from document_sections s
      join documents d on d.id = s.document_id
     where d.project_id = ${projectId}::uuid
     order by d.path asc, s.ordinal asc
  `);
  return rows.rows.map((r) => r.id);
}

/**
 * Re-extracts an entire project, one section at a time, in that fixed order.
 *
 * **Sequential, and deliberately not through the queue.** The queue is the right
 * shape for a document push, where order between sections is an ordinary
 * first-writer-wins race and either outcome is correct. It cannot give a
 * rebuild what a rebuild needs, because ordering the *enqueue* does not order
 * the *processing*: pg-boss hands work to however many workers are running, and
 * two of them will interleave whatever priorities the jobs carry. A rebuild
 * that fans out is a rebuild that cannot reproduce its own corpus.
 *
 * **Not an operation to offer anyone.** docs/05-extraction.md makes
 * re-derivation a test rather than a procedure: a literal delete-and-rebuild
 * over a real project returns the whole corpus to `provisional` and destroys
 * the record of every human decision ever made about it. Ratification does not
 * re-derive. The operational cousin is re-projection at a new
 * `extractor_version`, which matches new output against existing atoms and
 * leaves ratified ones standing — phase 4's work, not this one's. Nothing in
 * the CLI exposes either.
 */
export async function rebuildProject(
  db: Db,
  orgId: string,
  projectId: string,
  extractorVersion: string,
  run: (job: SectionExtractJob) => Promise<unknown>,
): Promise<string[]> {
  const actorId = await requireExtractorActor(db, orgId);
  const sections = await projectSectionsInOrder(db, projectId);

  for (const sectionId of sections) {
    await run({ orgId, actorId, projectId, sectionId, extractorVersion });
  }
  return sections;
}

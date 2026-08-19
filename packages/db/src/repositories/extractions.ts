import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

export type ClaimOutcome =
  /** We own the run. Proceed. */
  | { readonly kind: "claimed"; readonly id: string; readonly attempts: number }
  /** Somebody already finished this section at this version. Nothing to do. */
  | { readonly kind: "already-succeeded" }
  /** A live worker holds the lease. Nothing to do. */
  | { readonly kind: "held" }
  /** The section vanished between enqueue and run. Nothing to do. */
  | { readonly kind: "gone" };

/** What the worker needs to know about the section it was handed. */
export type SectionForExtraction = {
  readonly id: string;
  readonly orgId: string;
  readonly documentId: string;
  readonly projectId: string;
  readonly headingPath: string[];
  readonly body: string;
  readonly sectionHash: string;
};

export async function loadSectionForExtraction(
  db: Db,
  sectionId: string,
): Promise<SectionForExtraction | null> {
  const rows = await db.execute<SectionForExtraction>(sql`
    select s.id, s.org_id as "orgId", s.document_id as "documentId",
           d.project_id as "projectId", s.heading_path as "headingPath",
           s.body, s.section_hash as "sectionHash"
      from document_sections s
      join documents d on d.id = s.document_id
     where s.id = ${sectionId}::uuid
  `);
  return rows.rows[0] ?? null;
}

/**
 * Takes ownership of one section at one extractor version, or explains why not.
 *
 * The unique key on `(section_id, extractor_version)` does the work: the insert
 * either wins or tells us somebody else got there. Everything after that is
 * reading the incumbent row and deciding whether it is finished, alive, or the
 * remains of a worker that died.
 *
 * Takeover is a conditional UPDATE rather than a read-then-write. The condition
 * *is* the lock — two would-be takers cannot both match it — so no advisory
 * lock and no SELECT FOR UPDATE is needed.
 */
export async function claimExtraction(
  db: Db,
  input: {
    orgId: string;
    projectId: string;
    sectionId: string;
    sectionHash: string;
    extractorVersion: string;
    leaseSeconds: number;
  },
): Promise<ClaimOutcome> {
  const lease = sql`now() + make_interval(secs => ${input.leaseSeconds})`;

  const inserted = await db.execute<{ id: string; attempts: number }>(sql`
    insert into section_extractions
      (org_id, project_id, section_id, extractor_version, section_hash,
       status, attempts, started_at, lease_expires_at)
    values
      (${input.orgId}::uuid, ${input.projectId}::uuid, ${input.sectionId}::uuid,
       ${input.extractorVersion}, ${input.sectionHash},
       'running', 1, now(), ${lease})
    on conflict (section_id, extractor_version) do nothing
    returning id, attempts
  `);

  const won = inserted.rows[0];
  if (won) return { kind: "claimed", id: won.id, attempts: won.attempts };

  const existing = await db.execute<{
    id: string;
    status: "running" | "succeeded" | "failed";
    expired: boolean;
    attempts: number;
  }>(sql`
    select id, status, attempts,
           (lease_expires_at is null or lease_expires_at <= now()) as expired
      from section_extractions
     where section_id = ${input.sectionId}::uuid
       and extractor_version = ${input.extractorVersion}
  `);

  const row = existing.rows[0];
  if (!row) return { kind: "gone" };

  // The idempotency guarantee, and the reason a redelivered job is free.
  if (row.status === "succeeded") return { kind: "already-succeeded" };

  if (row.status === "running" && !row.expired) return { kind: "held" };

  // Either a crashed worker's lease has expired, or the previous attempt
  // failed. Both are retryable at the same version, and both reuse the row
  // because the unique key leaves no alternative — which is why `attempts` is a
  // counter rather than a row per try.
  const taken = await db.execute<{ id: string; attempts: number }>(sql`
    update section_extractions
       set status = 'running',
           attempts = attempts + 1,
           started_at = now(),
           lease_expires_at = ${lease},
           finished_at = null,
           error = null,
           candidates_total = null,
           candidates_dropped = null,
           candidates_truncated = false,
           section_hash = ${input.sectionHash}
     where id = ${row.id}::uuid
       and (status = 'failed'
            or (status = 'running'
                and (lease_expires_at is null or lease_expires_at <= now())))
    returning id, attempts
  `);

  const claimed = taken.rows[0];
  // Lost the race to another taker. Its lease is live, so this job is done.
  return claimed
    ? { kind: "claimed", id: claimed.id, attempts: claimed.attempts }
    : { kind: "held" };
}

export async function succeedExtraction(
  db: Db,
  input: {
    id: string;
    candidatesTotal: number;
    candidatesDropped: number;
    candidatesTruncated: boolean;
  },
): Promise<void> {
  await db.execute(sql`
    update section_extractions
       set status = 'succeeded',
           finished_at = now(),
           lease_expires_at = null,
           error = null,
           candidates_total = ${input.candidatesTotal},
           candidates_dropped = ${input.candidatesDropped},
           candidates_truncated = ${input.candidatesTruncated}
     where id = ${input.id}::uuid
  `);
}

export async function failExtraction(
  db: Db,
  id: string,
  error: string,
): Promise<void> {
  await db.execute(sql`
    update section_extractions
       set status = 'failed',
           finished_at = now(),
           lease_expires_at = null,
           error = ${error}
     where id = ${id}::uuid
  `);
}

export type NearestAtom = {
  readonly id: string;
  readonly statement: string;
  readonly similarity: number;
};

/**
 * The most similar existing atom in the project, by cosine similarity.
 *
 * Project-scoped, not org-scoped: docs/05-extraction.md is explicit that the
 * same sentence in two projects is two decisions that happen to agree. RLS
 * already confines the query to the org.
 *
 * No index, and that is deliberate for phase 1 — HNSW parameters are chosen
 * against a real vector distribution, and building one over a handful of rows
 * costs time and teaches nothing. Do not "fix" this.
 */
export async function nearestAtom(
  db: Db,
  projectId: string,
  embedding: readonly number[],
): Promise<NearestAtom | null> {
  const vector = `[${embedding.join(",")}]`;

  const rows = await db.execute<NearestAtom>(sql`
    select a.id, a.statement,
           1 - (a.embedding <=> ${vector}::vector) as similarity
      from atoms a
     where a.project_id = ${projectId}::uuid
       -- Not decoration. <=> against NULL yields NULL, 1 - NULL is NULL, and
       -- NULL > 0.93 is false — so an atom with no embedding would be silently
       -- classified "distinct" and the candidate written as its twin.
       and a.embedding is not null
     order by a.embedding <=> ${vector}::vector asc,
              -- Ties are not hypothetical: two identical statements in one
              -- project are distance 0 from the same candidate. Without a total
              -- order, duplicate_of_atom_id is nondeterministic and the rebuild
              -- snapshot in exit criterion 3 fails intermittently.
              a.created_at asc,
              a.id asc
     limit 1
  `);

  return rows.rows[0] ?? null;
}

/**
 * Why a candidate was discarded by deduplication.
 *
 * A closed set, because "how many did the >0.93 band throw away" should be a
 * query and not a string match. A quote that failed verification is **not** one
 * of these: it is counted in `section_extractions.candidates_dropped`, because
 * a suppression with a null `duplicate_of_atom_id` would poison
 * `atom_suppressions_orphaned_idx`, whose whole purpose is finding suppressions
 * whose winner is gone.
 */
export type SuppressionReason =
  | "duplicate:threshold"
  | "duplicate:judge"
  | "duplicate:batch";

export async function suppressCandidate(
  db: Db,
  input: {
    orgId: string;
    projectId: string;
    sectionId: string;
    statement: string;
    reason: SuppressionReason;
    similarity: number;
    duplicateOfAtomId: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    insert into atom_suppressions
      (org_id, project_id, section_id, statement, reason, similarity,
       duplicate_of_atom_id)
    values
      (${input.orgId}::uuid, ${input.projectId}::uuid, ${input.sectionId}::uuid,
       ${input.statement}, ${input.reason}, ${input.similarity},
       ${input.duplicateOfAtomId}::uuid)
  `);
}

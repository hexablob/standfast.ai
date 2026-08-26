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
    sectionHash: string;
    expired: boolean;
    attempts: number;
  }>(sql`
    select id, status, attempts, section_hash as "sectionHash",
           (lease_expires_at is null or lease_expires_at <= now()) as expired
      from section_extractions
     where section_id = ${input.sectionId}::uuid
       and extractor_version = ${input.extractorVersion}
  `);

  const row = existing.rows[0];
  if (!row) return { kind: "gone" };

  // The idempotency guarantee, and the reason a redelivered job is free — but
  // only at the hash that succeeded. `reconcileSections` keeps an edited
  // section's row and re-enqueues it, so "this section already succeeded at
  // this version" is no longer proof there is nothing to do: succeeded at a
  // *different* hash is finished work on text that no longer exists, and
  // honouring it would skip the re-extraction forever.
  if (row.status === "succeeded" && row.sectionHash === input.sectionHash) {
    return { kind: "already-succeeded" };
  }

  if (row.status === "running" && !row.expired) return { kind: "held" };

  // A crashed worker's lease has expired, the previous attempt failed, or the
  // run that succeeded was for a hash the section no longer has. All three are
  // retryable at the same version, and all reuse the row because the unique
  // key leaves no alternative — which is why `attempts` is a counter rather
  // than a row per try.
  //
  // The hash comparison is racy by nature and that is accepted: an edit that
  // lands while an extraction is in flight leaves a succeeded row at the old
  // hash until the *next* write re-enqueues the section. That class predates
  // this branch — the enqueue has always been the trigger, not a watcher.
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
                and (lease_expires_at is null or lease_expires_at <= now()))
            or (status = 'succeeded'
                and section_hash is distinct from ${input.sectionHash}))
    returning id, attempts
  `);

  const claimed = taken.rows[0];
  // Lost the race to another taker. Its lease is live, so this job is done.
  return claimed
    ? { kind: "claimed", id: claimed.id, attempts: claimed.attempts }
    : { kind: "held" };
}

/**
 * Whether a terminal write still owned the run it was recording.
 *
 * `claim-lost` is not an error and not a failure of the extraction. It is the
 * ordinary outcome of finishing a run that a successor has already taken over,
 * and the only correct response to it is to discard the work — never to stamp
 * it over the successor's row.
 */
export type TerminalWrite = "recorded" | "claim-lost";

/**
 * The fence both terminal writes carry: this row, at the attempt we claimed.
 *
 * The row id alone is not ownership. `claimExtraction` reuses the row — the
 * unique key on `(section_id, extractor_version)` leaves it no alternative — so
 * a successor's run is the *same* id, and a write fenced on the id alone lands
 * on the successor's run as happily as on its own.
 *
 * `attempts` is the token — the value `claimExtraction` handed this run — and
 * not the tempting `status = 'running' and lease_expires_at > now()`, which
 * needs no plumbing and is wrong in both directions:
 *
 * - It **permits** the write it was proposed to stop. A successor's claim
 *   leaves the row `running` with a fresh lease, so the predicate is at its
 *   truest precisely when a loser is about to overwrite a live claim.
 * - It **refuses** a write that harms nobody: a worker that finished just after
 *   its own lease lapsed with no successor having appeared. That discards a
 *   completed extraction — a model call already paid for, every atom it
 *   produced, and the record that the section was ever extracted — to defend
 *   against a writer that does not exist. Silently throwing away good work is
 *   its own harm.
 *
 * `attempts` moves when, and only when, a takeover actually happens. It refuses
 * the write that would land on somebody else's run and accepts the write that
 * would land on nothing. The lease says when a row *may* be taken; the counter
 * says whether it *was*, and only the second question is ownership.
 */
const owns = (id: string, attempts: number) =>
  sql`id = ${id}::uuid and attempts = ${attempts}`;

export async function succeedExtraction(
  db: Db,
  input: {
    id: string;
    /** The value `claimExtraction` returned for this run. */
    attempts: number;
    candidatesTotal: number;
    candidatesDropped: number;
    candidatesTruncated: boolean;
  },
): Promise<TerminalWrite> {
  const stamped = await db.execute<{ id: string }>(sql`
    update section_extractions
       set status = 'succeeded',
           finished_at = now(),
           lease_expires_at = null,
           error = null,
           candidates_total = ${input.candidatesTotal},
           candidates_dropped = ${input.candidatesDropped},
           candidates_truncated = ${input.candidatesTruncated}
     where ${owns(input.id, input.attempts)}
    returning id
  `);
  return stamped.rows.length === 1 ? "recorded" : "claim-lost";
}

export async function failExtraction(
  db: Db,
  id: string,
  /** The value `claimExtraction` returned for this run. */
  attempts: number,
  error: string,
): Promise<TerminalWrite> {
  // Fenced for the same reason as the success. An unfenced failure is the worse
  // of the two: `failed` matches the takeover condition in `claimExtraction`, so
  // stamping it on a row a live worker still holds invites a third worker to
  // claim it — two extractors on one section at one version, both writing atoms,
  // and nothing downstream that would recognise them as the same run.
  const stamped = await db.execute<{ id: string }>(sql`
    update section_extractions
       set status = 'failed',
           finished_at = now(),
           lease_expires_at = null,
           error = ${error}
     where ${owns(id, attempts)}
    returning id
  `);
  return stamped.rows.length === 1 ? "recorded" : "claim-lost";
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
 * Phase 1 ran this unindexed on purpose — HNSW parameters are chosen against
 * a real vector distribution, and a handful of rows teaches nothing. Phase 2
 * then needed the same operator class for its first candidate generator, so
 * migration 0007 built `atoms_embedding_hnsw_idx` and this query now rides
 * it; the parameters, and why the choice splits between build time and query
 * time, are documented there.
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

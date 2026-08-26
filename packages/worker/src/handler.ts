import {
  bandFor,
  cosineSimilarity,
  type EgressEntry,
  locateQuote,
} from "@standfast/core";
import {
  claimExtraction,
  createAtom,
  type Db,
  failExtraction,
  loadSectionForExtraction,
  nearestAtom,
  recordEgress,
  type SectionExtractJob,
  type SuppressionReason,
  setAtomEmbedding,
  succeedExtraction,
  suppressCandidate,
  withActor,
} from "@standfast/db";
import type { Candidate, Ports } from "./ports.js";
import { EMBEDDING_DIMENSIONS } from "./ports.js";

/** How long a claim is held before another worker may take it over. */
export const DEFAULT_LEASE_SECONDS = 900;

/**
 * The most candidates one section may yield.
 *
 * A cap rather than a hope. Uncapped, one bad prompt on one push floods the
 * ratification queue — and ratification throughput is phase 4's owned metric,
 * so the damage would land in a phase that cannot see the cause. When it bites,
 * `candidates_truncated` is *set* on the extraction row, never inferred from a
 * count, for the same reason a context pack sets `truncated`: a cap that
 * applies silently reads as a section that had nothing more to say.
 */
export const DEFAULT_CANDIDATE_CAP = 50;

export type HandlerConfig = {
  readonly ports: Ports;
  readonly leaseSeconds?: number;
  readonly candidateCap?: number;
};

export type HandlerOutcome = {
  readonly status: "extracted" | "skipped";
  readonly reason?: string;
  readonly candidatesTotal: number;
  readonly candidatesDropped: number;
  readonly candidatesTruncated: boolean;
  readonly written: number;
  readonly suppressed: number;
};

const SKIPPED = (reason: string): HandlerOutcome => ({
  status: "skipped",
  reason,
  candidatesTotal: 0,
  candidatesDropped: 0,
  candidatesTruncated: false,
  written: 0,
  suppressed: 0,
});

/** A stage name, prefixed onto any error so a failure says where it happened. */
type Stage =
  | "disclose"
  | "extract"
  | "verify"
  | "embed"
  | "scan"
  | "judge"
  | "write";

/**
 * Thrown only to roll the write transaction back when the fence rejects it.
 *
 * Never reaches a caller: the atoms and the terminal stamp share one
 * transaction, so aborting is how the atoms this worker no longer has the right
 * to write are discarded along with the stamp it was refused.
 */
class ClaimLost extends Error {}

function errorText(stage: Stage, error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown");
  // First line only, and truncated. `section_extractions.error` is in
  // WIRE_ALLOWLIST and the `status` tool will eventually surface it, so this
  // string must never be able to carry document prose or a candidate
  // statement — only the stage and what the port said went wrong.
  return `${stage}: ${message.split("\n")[0] ?? ""}`.slice(0, 2000);
}

/**
 * Runs one `section.extract` job.
 *
 * The transaction boundaries are the load-bearing part, not the stage list.
 * Every model call happens with no Postgres transaction open. The naive
 * shape — scan, judge, write, all in one transaction — puts a network call
 * inside a transaction holding row locks on `atoms`, which under any real load
 * is a connection-pool exhaustion incident. Two passes with the judge between
 * them costs one extra round trip and removes the failure mode.
 */
export function makeSectionExtractHandler(
  config: HandlerConfig,
): (job: SectionExtractJob, signal: AbortSignal) => Promise<HandlerOutcome> {
  const leaseSeconds = config.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const cap = config.candidateCap ?? DEFAULT_CANDIDATE_CAP;
  const { extractor, embedder, judge } = config.ports;

  return async function handle(job, signal) {
    const actor = <T>(fn: (db: Db) => Promise<T>): Promise<T> =>
      withActor(job.orgId, job.actorId, fn);

    // ── 1. Claim, in its own short transaction ──────────────────────────────
    const claim = await actor(async (db) => {
      const section = await loadSectionForExtraction(db, job.sectionId);
      if (!section) return { outcome: null, section: null } as const;

      if (section.projectId !== job.projectId) {
        // RLS confines this to the org; this closes the residual cross-project
        // case for the cost of one join.
        throw new Error("payload project does not own section");
      }

      const outcome = await claimExtraction(db, {
        orgId: section.orgId,
        projectId: section.projectId,
        sectionId: section.id,
        sectionHash: section.sectionHash,
        extractorVersion: job.extractorVersion,
        leaseSeconds,
      });
      return { outcome, section } as const;
    });

    // The document was deleted between enqueue and run. A race the design
    // permits, not an error.
    if (!claim.section || !claim.outcome) return SKIPPED("section is gone");
    if (claim.outcome.kind !== "claimed") return SKIPPED(claim.outcome.kind);

    // `attempts` is the fence every terminal write below carries. Captured here
    // because this is the only moment it is true: from now on the value in the
    // row is whatever the last claimant left, and a run that reread it would be
    // asking the successor for permission to overwrite the successor.
    const { id: claimId, attempts } = claim.outcome;
    const section = claim.section;

    /**
     * A successor took this run over while a model call was open.
     *
     * Not an error, and not an extraction: the section was re-hashed under this
     * worker, so its candidates describe text that may no longer be there, and
     * the successor is extracting the text that is. Said out loud because the
     * discarded run cost a model call — a worker that reports this repeatedly
     * has a lease shorter than its provider's tail latency, and nothing else in
     * the system would ever say so.
     */
    const claimLost = (): HandlerOutcome => {
      console.error(
        `section.extract: section ${section.id} was taken over mid-run at attempt ${attempts}; this worker's result is discarded`,
      );
      return SKIPPED("claim lost");
    };

    /**
     * Writes what is about to leave, before it leaves.
     *
     * `docs/13-threat-model.md` (*Egress*, rule 3). Ports that open no socket
     * carry `egress: null` and produce no row, so a run on the deterministic
     * fakes writes nothing here and says so — the absence of rows is evidence,
     * not an oversight.
     *
     * Before the call, and in its own short transaction with no model call
     * open. If the record cannot be written the request is not made: a system
     * that sends what it cannot account for has not disclosed anything, and
     * the cost of the stricter order is one failed section rather than a gap
     * nobody can see.
     */
    const disclose = async (
      egress: EgressEntry | null,
      inputs: readonly string[],
    ): Promise<void> => {
      if (!egress) return;
      try {
        await actor((db) =>
          recordEgress(db, {
            orgId: section.orgId,
            projectId: section.projectId,
            sectionId: section.id,
            purpose: egress.purpose,
            destination: egress.origin,
            model: egress.model,
            inputItems: inputs.length,
            // How much, never what. Nothing on this path can carry prose into
            // the table; see `egress_events` in the schema.
            inputChars: inputs.reduce((total, text) => total + text.length, 0),
          }),
        );
      } catch (error) {
        throw new Error(errorText("disclose", error));
      }
    };

    try {
      // ── 2. The model call. No transaction is open. ───────────────────────
      let candidates: readonly Candidate[];
      await disclose(extractor.egress, [section.body]);
      try {
        candidates = await extractor.extract(
          { headingPath: section.headingPath, body: section.body },
          signal,
        );
      } catch (error) {
        throw new Error(errorText("extract", error));
      }

      const truncated = candidates.length > cap;
      const considered = truncated ? candidates.slice(0, cap) : candidates;

      // ── 3. Verbatim verification. Pure, no transaction. ──────────────────
      const located = considered.map((candidate) => ({
        candidate,
        span: locateQuote(section.body, candidate.quote),
      }));
      const survivors = located.filter(
        (l): l is { candidate: Candidate; span: NonNullable<typeof l.span> } =>
          l.span !== null,
      );
      const dropped = located.length - survivors.length;

      if (survivors.length === 0) {
        // Nothing was written, so there is nothing to roll back — the stamp is
        // the whole of this transaction, and losing it is simply the end.
        const stamped = await actor((db) =>
          succeedExtraction(db, {
            id: claimId,
            attempts,
            candidatesTotal: candidates.length,
            candidatesDropped: dropped,
            candidatesTruncated: truncated,
          }),
        );
        if (stamped === "claim-lost") return claimLost();
        return {
          status: "extracted",
          candidatesTotal: candidates.length,
          candidatesDropped: dropped,
          candidatesTruncated: truncated,
          written: 0,
          suppressed: 0,
        };
      }

      // ── 4. Embedding. No transaction. ────────────────────────────────────
      let vectors: readonly (readonly number[])[];
      const toEmbed = survivors.map((s) => s.candidate.statement);
      await disclose(embedder.egress, toEmbed);
      try {
        vectors = await embedder.embed(toEmbed, signal);
      } catch (error) {
        throw new Error(errorText("embed", error));
      }

      if (vectors.length !== survivors.length) {
        throw new Error(
          errorText(
            "embed",
            new Error(
              `expected ${survivors.length} vectors, got ${vectors.length}`,
            ),
          ),
        );
      }
      for (const vector of vectors) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          // A provider returning 1536 where the column is 1024 fails here, with
          // a legible message, rather than at the INSERT.
          throw new Error(
            errorText(
              "embed",
              new Error(
                `expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}`,
              ),
            ),
          );
        }
      }

      // ── 5. Similarity scan, one short read transaction. ──────────────────
      let scanned: Array<{
        index: number;
        nearest: Awaited<ReturnType<typeof nearestAtom>>;
      }>;
      try {
        scanned = await actor(async (db) => {
          const out = [];
          for (const [index, vector] of vectors.entries()) {
            out.push({
              index,
              nearest: await nearestAtom(db, section.projectId, vector),
            });
          }
          return out;
        });
      } catch (error) {
        throw new Error(errorText("scan", error));
      }

      // ── 6. The judge, for in-band pairs only. No transaction. ────────────
      type Decision =
        | { write: true; index: number }
        | {
            write: false;
            index: number;
            reason: SuppressionReason;
            similarity: number;
            duplicateOf: string | null;
          };

      const decisions: Decision[] = [];
      // Candidates accepted earlier in this batch are incumbents for the ones
      // that follow. Compared in memory: the embedder already returned every
      // vector, so candidate-against-candidate needs no database at all.
      const acceptedInBatch: Array<{
        index: number;
        vector: readonly number[];
      }> = [];

      for (const { index, nearest } of scanned) {
        const vector = vectors[index] as readonly number[];

        let best: { similarity: number; id: string | null; statement: string } =
          nearest
            ? {
                similarity: nearest.similarity,
                id: nearest.id,
                statement: nearest.statement,
              }
            : { similarity: -1, id: null, statement: "" };

        for (const prior of acceptedInBatch) {
          const similarity = cosineSimilarity(vector, prior.vector);
          if (similarity > best.similarity) {
            best = {
              similarity,
              id: null,
              statement: survivors[prior.index]?.candidate.statement ?? "",
            };
          }
        }

        const band =
          best.similarity < 0 ? "distinct" : bandFor(best.similarity);

        if (band === "duplicate") {
          decisions.push({
            write: false,
            index,
            reason: best.id ? "duplicate:threshold" : "duplicate:batch",
            similarity: best.similarity,
            duplicateOf: best.id,
          });
          continue;
        }

        if (band === "judge") {
          let verdict: string;
          const pair = {
            candidate: survivors[index]?.candidate.statement ?? "",
            incumbent: best.statement,
          };
          // One row per adjudication, because each is its own request. A
          // section that reaches the judge four times sent four things.
          await disclose(judge.egress, [pair.candidate, pair.incumbent]);
          try {
            verdict = await judge.adjudicate(pair, signal);
          } catch (error) {
            throw new Error(errorText("judge", error));
          }

          if (verdict === "same-claim") {
            decisions.push({
              write: false,
              index,
              reason: best.id ? "duplicate:judge" : "duplicate:batch",
              similarity: best.similarity,
              duplicateOf: best.id,
            });
            continue;
          }
        }

        decisions.push({ write: true, index });
        acceptedInBatch.push({ index, vector });
      }

      // ── 7. The only write transaction. All of it, or none of it. ─────────
      let written = 0;
      let suppressed = 0;
      try {
        await actor(async (db) => {
          for (const decision of decisions) {
            const entry = survivors[decision.index];
            if (!entry) continue;

            if (decision.write) {
              // The same createAtom the API calls. No status parameter, so the
              // atom is born provisional like every other, and the proposed
              // event is written by that function rather than here.
              const atom = await createAtom(db, section.orgId, job.actorId, {
                projectId: section.projectId,
                documentId: section.documentId,
                sectionId: section.id,
                statement: entry.candidate.statement,
                kind: entry.candidate.kind,
                sourceQuote: entry.candidate.quote,
                sourceSpan: entry.span,
                extractorVersion: job.extractorVersion,
              });
              await setAtomEmbedding(
                db,
                atom.id,
                vectors[decision.index] as readonly number[],
              );
              written += 1;
            } else {
              // The incumbent is not touched. "Merge" means the candidate is
              // not written, and nothing that already exists is modified,
              // demoted or deleted.
              await suppressCandidate(db, {
                orgId: section.orgId,
                projectId: section.projectId,
                sectionId: section.id,
                statement: entry.candidate.statement,
                reason: decision.reason,
                similarity: decision.similarity,
                duplicateOfAtomId: decision.duplicateOf,
              });
              suppressed += 1;
            }
          }

          // Last, and inside the same transaction as the atoms above, which is
          // what makes the fence a rollback rather than a repair: a run that no
          // longer owns the claim takes its atoms down with its stamp.
          const stamped = await succeedExtraction(db, {
            id: claimId,
            attempts,
            candidatesTotal: candidates.length,
            candidatesDropped: dropped,
            candidatesTruncated: truncated,
          });
          if (stamped === "claim-lost") throw new ClaimLost();
        });
      } catch (error) {
        if (error instanceof ClaimLost) return claimLost();
        throw new Error(errorText("write", error));
      }

      return {
        status: "extracted",
        candidatesTotal: candidates.length,
        candidatesDropped: dropped,
        candidatesTruncated: truncated,
        written,
        suppressed,
      };
    } catch (error) {
      // A separate short transaction: the one that failed may be aborted, and
      // the failure has to be recorded either way.
      await actor((db) =>
        failExtraction(
          db,
          claimId,
          attempts,
          error instanceof Error && /^[a-z]+: /.test(error.message)
            ? error.message.slice(0, 2000)
            : errorText("write", error),
        ),
      )
        .then((stamped) => {
          // The failure belongs to this run, and this run is no longer the one
          // the row describes. Announced and dropped: `failed` is what the
          // takeover condition looks for, so writing it onto a successor's live
          // claim would invite a third worker onto the same section.
          if (stamped === "claim-lost") claimLost();
        })
        .catch(() => {
          // Recording the failure failed too. Nothing further to do here; the
          // row keeps its expired lease and the next worker takes it over.
        });
      throw error;
    }
  };
}

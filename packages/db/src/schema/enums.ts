import { EGRESS_PURPOSES } from "@standfast/core";
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Human or agent. This is not descriptive metadata — `actors` is unique on
 * `(id, kind)` so that `atoms` can carry a composite foreign key to
 * `(id, 'human')`. That is what makes "an agent cannot promote its own
 * knowledge" a database constraint rather than a code path.
 */
export const actorKind = pgEnum("actor_kind", ["human", "agent"]);

export const atomStatus = pgEnum("atom_status", [
  "provisional",
  "canonical",
  "rejected",
  "superseded",
]);

export const atomKind = pgEnum("atom_kind", [
  "decision",
  "convention",
  "constraint",
]);

export const atomEvent = pgEnum("atom_event", [
  "proposed",
  "ratified",
  "rejected",
  "superseded",
]);

/**
 * The outcome of one extraction run over one section.
 *
 * `running` exists so that a crashed worker leaves evidence. Recording only
 * terminal states would make an abandoned run indistinguishable from a section
 * nobody has reached yet, and those two need different repairs.
 */
export const extractionStatus = pgEnum("extraction_status", [
  "running",
  "succeeded",
  "failed",
]);

/**
 * What an outbound call was for.
 *
 * Built from `EGRESS_PURPOSES` rather than repeating it, so the column and the
 * policy that governs it cannot drift apart. Every value is here, including the
 * two no deployment may configure — `reranking` and `query-embedding`: this
 * column records what a call *was* for, and a purpose the type cannot express
 * is a call that would have to be written down as something it was not.
 * Whether a purpose may be configured at all is `PERMITTED_PURPOSES`, in core,
 * and this enum is deliberately not that check.
 *
 * Counting them in this comment was a mistake once already — it said "all four"
 * and stayed saying it while a fifth was added — so it does not count them now.
 */
export const egressPurpose = pgEnum("egress_purpose", EGRESS_PURPOSES);

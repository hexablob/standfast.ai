import { type MmrCandidate, mmrSelect } from "./mmr.js";
import { tokenUpperBound } from "./tokens.js";

/**
 * Assembly of a context pack under a token budget.
 *
 * `docs/06-retrieval.md` (*Assembly under a token budget*) settles four things,
 * and each is a place the obvious implementation is wrong:
 *
 * 1. **The budget is a gate, not a target.** `docs/14-roadmap.md` phase 2 exit
 *    criterion 1: the assembled pack is at or under `budgetTokens` for every
 *    query in the corpus. Approximating it is failing it.
 * 2. **The bound is computed over the serialised pack**, not over the sum of
 *    statement lengths, because the envelope and the provenance fields cost
 *    tokens too.
 * 3. **A packed atom carries provenance, not the quote.** `atomId`,
 *    `statement`, `kind` and a `document path#section` reference. Provenance is
 *    surfaced because `docs/02-principles.md` (13) requires it of an instruction
 *    channel; the verbatim quote is one `read` call away, and a pack that spends
 *    half its budget on quotations nobody reads has bought nothing.
 * 4. **Ordering is part of the contract.** `constraint`, then `convention`,
 *    then `decision` — deterministically, not by score.
 *
 * This runs server side, behind the API rather than in the MCP package: MMR
 * needs the vectors, the vectors are in the database, and the MCP server does
 * not talk to Postgres (`docs/03-architecture.md`).
 */

/**
 * The three atom kinds, in pack order.
 *
 * Attention is positional and the cost of an agent missing a constraint is
 * higher than the cost of it missing a decision, so a constraint is never below
 * a decision in a pack however the scores fell.
 *
 * Declared here rather than imported because `packages/core` is pure domain and
 * takes no dependency on `packages/db`. `packages/db` owns the enum this must
 * equal, and an equality test there fails the build if the two ever drift —
 * the same mechanism the wire allowlist uses.
 */
export const PACK_ORDER = ["constraint", "convention", "decision"] as const;

export type PackKind = (typeof PACK_ORDER)[number];

/** A candidate the fused query returned, with everything assembly needs. */
export type PackCandidate = MmrCandidate & {
  readonly statement: string;
  readonly kind: PackKind;
  /** `document path#section`. Never the full source quote. */
  readonly provenance: string;
};

/** What an agent reads. Four fields, and the budget is why there are four. */
export type PackedAtom = {
  readonly atomId: string;
  readonly statement: string;
  readonly kind: PackKind;
  readonly provenance: string;
};

export type Pack = {
  readonly items: PackedAtom[];
  /**
   * Candidates that survived fusion — **not** atoms that could have matched,
   * which is a number nobody can compute.
   *
   * `docs/06-retrieval.md` (*Truncation*) documents the meaning here because an
   * agent reading `total: 47` as "there are 47 relevant atoms" would be
   * reasoning from a fact that was never claimed.
   */
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  /**
   * An upper bound on the pack's cost, not a measurement of it.
   *
   * See {@link tokenUpperBound}. Reported rather than hidden, because a client
   * that treats it as exact and packs a second thing beside it should be
   * treating it as a ceiling.
   */
  readonly budgetTokensUsed: number;
};

/**
 * Serialises a pack the way the API will send it, for counting.
 *
 * `budgetTokensUsed` is set to the whole budget rather than to the running
 * total, because the field's own digits cost tokens and the count has to stay
 * an upper bound while it is still being computed. The budget is the largest
 * value the field can take, so counting with it can only over-estimate — which
 * is the safe direction and the only one this function is allowed to err in.
 */
function serialiseForCount(
  items: readonly PackedAtom[],
  budgetTokens: number,
  skipped: readonly string[],
): string {
  return JSON.stringify({
    items,
    total: items.length,
    returned: items.length,
    truncated: true,
    budgetTokensUsed: budgetTokens,
    skipped,
  });
}

/**
 * What an empty pack costs, before a single atom is added.
 *
 * The envelope is not free: `items`, `total`, `returned`, `truncated`,
 * `budgetTokensUsed` and `skipped` are sent whatever the pack holds, and
 * {@link tokenUpperBound} charges a token for each brace, quote, colon and
 * comma among them. Computed rather than written down, so it cannot drift from
 * the shape it measures.
 *
 * **The one case where `budgetTokensUsed` exceeds `budgetTokens`.** A caller
 * asking for a budget below this floor has asked for something no response can
 * satisfy — even the empty one costs this much. The pack comes back empty and
 * truncated, and the reported cost is the floor rather than zero, because zero
 * would be a number that does not match what the agent actually received.
 * Reporting the truth here is worth more than a gate that holds by lying:
 * `docs/14-roadmap.md` phase 2 exit criterion 1 gates budgets in the corpus,
 * and no realistic budget is below fifty-odd tokens.
 */
export const EMPTY_PACK_TOKENS = tokenUpperBound(
  JSON.stringify({
    items: [],
    total: 0,
    returned: 0,
    truncated: true,
    budgetTokensUsed: 0,
    skipped: [],
  }),
);

function packed(candidate: PackCandidate): PackedAtom {
  return {
    atomId: candidate.atomId,
    statement: candidate.statement,
    kind: candidate.kind,
    provenance: candidate.provenance,
  };
}

/**
 * Selects and orders a pack that fits `budgetTokens`.
 *
 * `upstreamTruncated` is whether any earlier stage — a generator's cap, the
 * fused list's cap — already dropped something. It is passed in and OR-ed,
 * never inferred: by the time a boundary could compare `returned` against
 * `total`, the information that something was dropped upstream is gone
 * (`docs/06-retrieval.md`, *Truncation*).
 *
 * An empty pack is a valid answer and never an error. A budget too small for
 * even one atom, no candidates above threshold, a project with no canonical
 * atoms — `docs/01-thesis.md` has the agent proceed on its own judgment, so
 * these return `items: []` and let it.
 */
export function assemblePack(input: {
  readonly candidates: readonly PackCandidate[];
  readonly budgetTokens: number;
  readonly upstreamTruncated: boolean;
  readonly skipped: readonly string[];
}): Pack {
  const { candidates, budgetTokens, upstreamTruncated, skipped } = input;

  const byId = new Map(candidates.map((c) => [c.atomId, c]));

  const { selected, dropped } = mmrSelect(candidates, (candidate, chosen) => {
    const prospective = [...chosen, candidate]
      .map((c) => byId.get(c.atomId))
      .filter((c): c is PackCandidate => c !== undefined)
      .map(packed);

    return (
      tokenUpperBound(serialiseForCount(prospective, budgetTokens, skipped)) <=
      budgetTokens
    );
  });

  // Selection order is MMR's; presentation order is the contract's. Sorting
  // after selection rather than before is what keeps both true at once.
  const items = selected
    .map((c) => byId.get(c.atomId))
    .filter((c): c is PackCandidate => c !== undefined)
    .map(packed)
    .sort((a, b) => PACK_ORDER.indexOf(a.kind) - PACK_ORDER.indexOf(b.kind));

  return {
    items,
    total: candidates.length,
    returned: items.length,
    truncated: upstreamTruncated || dropped > 0,
    budgetTokensUsed: tokenUpperBound(
      serialiseForCount(items, budgetTokens, skipped),
    ),
  };
}

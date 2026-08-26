/**
 * Scoring for retrieval precision under a fixed token budget.
 *
 * Pure: the runner produces one {@link PackRecord} per (query, budget) and this
 * module turns them into the three numbers docs/12-evaluation.md §2 says must
 * travel together — precision over the delivered pack, budget used, and
 * displacement — reported as a curve across budgets, with the paraphrase slice
 * on its own.
 */

import { type Interval, proportion } from "./interval.js";

export type PackRecord = {
  readonly queryId: string;
  readonly paraphrased: boolean;
  readonly budgetTokens: number;
  /** The pack's reported upper bound, from `assemblePack`. */
  readonly budgetTokensUsed: number;
  /**
   * Expected-atom ids of the delivered pack, where the delivered atom maps to
   * one; otherwise the raw atom id, which can never appear in `governing` and
   * so counts against precision — an atom the blind labels never named does
   * not govern the work by the only definition the harness has.
   */
  readonly delivered: readonly string[];
  /**
   * The query's `governs` ids that exist as canonical atoms in this run.
   * Displacement is measured against what existed, not against wishes: a
   * governing atom the extraction never produced is a recall failure of
   * extraction, already measured there.
   */
  readonly governing: readonly string[];
};

export type BudgetScore = {
  readonly budgetTokens: number;
  readonly queries: number;
  readonly delivered: number;
  readonly governingDelivered: number;
  /** Pooled: governing atoms delivered / atoms delivered. Null when nothing was. */
  readonly precision: number | null;
  /**
   * Wilson 95% interval on `precision`. Its n is `delivered` — the atoms in the
   * packs, not the queries — because precision is a proportion of delivered
   * atoms. The atoms of one query are not independent draws, so this is the
   * narrowest the band can honestly be, never wider than the truth.
   */
  readonly precisionInterval: Interval | null;
  /** Governing atoms that existed and were not in the pack — the recall side. */
  readonly displacement: number;
  readonly budgetTokensUsedMax: number;
};

export type RetrievalScore = {
  /** The curve, ascending by budget. */
  readonly budgets: BudgetScore[];
  /** The same curve over the paraphrased queries only. */
  readonly paraphrased: BudgetScore[];
};

function scoreSlice(records: readonly PackRecord[]): BudgetScore[] {
  const byBudget = new Map<number, PackRecord[]>();
  for (const record of records) {
    const bucket = byBudget.get(record.budgetTokens) ?? [];
    bucket.push(record);
    byBudget.set(record.budgetTokens, bucket);
  }

  return [...byBudget.keys()]
    .sort((a, b) => a - b)
    .map((budget) => {
      const bucket = byBudget.get(budget) ?? [];
      let delivered = 0;
      let governingDelivered = 0;
      let displacement = 0;
      let usedMax = 0;

      for (const record of bucket) {
        const governing = new Set(record.governing);
        const hit = record.delivered.filter((id) => governing.has(id));
        delivered += record.delivered.length;
        governingDelivered += hit.length;
        displacement += governing.size - new Set(hit).size;
        usedMax = Math.max(usedMax, record.budgetTokensUsed);
      }

      const scored = proportion(governingDelivered, delivered);
      return {
        budgetTokens: budget,
        queries: bucket.length,
        delivered,
        governingDelivered,
        precision: scored.rate,
        precisionInterval: scored.interval,
        displacement,
        budgetTokensUsedMax: usedMax,
      };
    });
}

export function scoreRetrieval(records: readonly PackRecord[]): RetrievalScore {
  return {
    budgets: scoreSlice(records),
    paraphrased: scoreSlice(records.filter((record) => record.paraphrased)),
  };
}

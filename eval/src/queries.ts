import { join } from "node:path";
import { z } from "zod";
import type { Corpus, Problem } from "./corpus.js";
import { type Loaded, loadDirectory } from "./parse.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `sectionHash#index` — the same identity `expectedAtomId` in labels.ts mints.
 *
 * A query's `governs` list names expected atoms from the section label sets,
 * not database rows: database ids are minted per run, and a label that named
 * one would be stale before it was committed. The runner joins these to live
 * atoms through the scored extraction run's `matched` adjudications.
 */
const EXPECTED_ATOM_ID = /^[0-9a-f]{64}#\d+$/;

/**
 * One labelled query: a task description, file paths, or both, and the atoms a
 * human says govern it (docs/12-evaluation.md, §2 *Corpus*).
 *
 * `paraphrased` marks the slice deliberately worded away from the atom's
 * vocabulary. It is the only part of the query set that distinguishes the
 * semantic generators from the lexical ones, and it is reported on its own.
 */
const LabelledQuery = z
  .object({
    id: z.string().min(1),
    /** Mirrors the `context` tool: `file` has paths and no free text. */
    scope: z.enum(["task", "file"]),
    task: z.string().min(1).nullable(),
    paths: z.array(z.string().min(1)),
    paraphrased: z.boolean(),
    governs: z.array(z.string().regex(EXPECTED_ATOM_ID)),
  })
  .refine((query) => (query.scope === "file" ? query.paths.length > 0 : true), {
    message: "a file-scoped query must name at least one path",
  })
  .refine((query) => (query.scope === "task" ? query.task !== null : true), {
    message: "a task-scoped query must carry a task description",
  });

/**
 * One file per labeller, at `queries/<labeller>.json`.
 *
 * There is no `pnpm eval skeleton` for queries, on purpose: a document skeleton
 * enumerates sections that already exist, but a query set has nothing to
 * enumerate from — writing the queries *is* the labelling, done from the code
 * and the task rather than from the atom list (docs/12-evaluation.md, §2).
 *
 * `budgets` is committed with the labels because docs/12 requires a curve
 * across at least three budgets — a single figure at a single budget can be
 * tuned into existence.
 */
export const QuerySet = z.object({
  version: z.literal(1),
  labeller: z.string().min(1),
  labelledOn: z.string().regex(ISO_DATE),
  blind: z.boolean(),
  modelAssisted: z.boolean(),
  budgets: z.array(z.number().int().positive()).min(3),
  queries: z.array(LabelledQuery).min(1),
});

export type LabelledQuery = z.infer<typeof LabelledQuery>;
export type QuerySet = z.infer<typeof QuerySet>;

/** Empty when `eval/queries/` does not exist or holds nothing — the skip case. */
export function loadQuerySets(root: string): Loaded<QuerySet> {
  return loadDirectory(
    join(root, "queries"),
    () => true,
    QuerySet,
    (name) => `queries/${name}`,
  );
}

/**
 * What `check` can say about a query set before a run exists.
 *
 * Every expected atom id names a section by hash. A hash that is in no corpus
 * document is a query written against a document that has since moved, and it
 * will silently deflate retrieval precision — the same class of error the
 * orphaned-section check already catches for section labels, and worth catching
 * in the same session rather than at the end of a run.
 */
export function checkQuerySets(
  corpus: Corpus,
  sets: readonly QuerySet[],
): Problem[] {
  const known = new Set(
    corpus.documents.flatMap((d) => d.sections.map((s) => s.sectionHash)),
  );
  const problems: Problem[] = [];
  for (const set of sets) {
    const seen = new Set<string>();
    for (const query of set.queries) {
      if (seen.has(query.id)) {
        problems.push({
          level: "error",
          message: `queries (${set.labeller}): query id '${query.id}' is used twice`,
        });
      }
      seen.add(query.id);

      for (const atomId of query.governs) {
        const hash = atomId.split("#")[0] as string;
        if (!known.has(hash)) {
          problems.push({
            level: "error",
            message:
              `queries (${set.labeller}): query '${query.id}' expects atom ` +
              `${atomId}, whose section is in no corpus document — the ` +
              "document moved and the query needs re-pointing",
          });
        }
      }
    }
    if (!set.blind) {
      problems.push({
        level: "warning",
        message: `queries (${set.labeller}): not blind-first — any run using it is contaminated`,
      });
    }
    if (set.modelAssisted) {
      problems.push({
        level: "warning",
        message: `queries (${set.labeller}): model-assisted — any run using it is marked as such`,
      });
    }
  }
  return problems;
}

const Model = z.object({ name: z.string().min(1), version: z.string().min(1) });

/**
 * A committed retrieval run. Unlike an extraction worksheet it carries its
 * score from the start: the labels (which atoms govern which query) precede
 * the run, so scoring is arithmetic, not adjudication.
 */
export const RetrievalRunFile = z.object({
  version: z.literal(1),
  metric: z.literal("retrieval_precision_under_budget"),
  ranOn: z.string().regex(ISO_DATE),
  corpusRevision: z.string().min(1),
  codeRevision: z.string().min(1),
  /** All three: the atoms being retrieved were produced by all of them. */
  models: z.object({ extraction: Model, embedding: Model, judge: Model }),
  extractorVersion: z.string().min(1),
  configuration: z.record(z.string(), z.unknown()),
  /**
   * docs/12 requires precision with and without the reranker as two regimes.
   * No reranker provider is bound yet, so every run so far is fused-only, and
   * the field says so rather than leaving a reader to guess which regime a
   * number came from.
   */
  reranker: z.enum(["fused-only", "reranked"]),
  /** The adjudicated extraction run whose accepted atoms were ratified. */
  scoredRun: z.string().min(1),
  labels: z.object({
    labellers: z.array(z.string().min(1)).min(1),
    blind: z.boolean(),
    modelAssisted: z.boolean(),
  }),
  budgets: z.array(z.number().int().positive()).min(3),
  queryCount: z.number().int().positive(),
  ratifiedAtoms: z.number().int().nonnegative(),
  score: z.unknown(),
});

export type RetrievalRunFile = z.infer<typeof RetrievalRunFile>;

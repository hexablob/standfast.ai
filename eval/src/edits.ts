import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FINDING_VERDICTS } from "@standfast/core";
import { z } from "zod";
import { ATOM_KINDS } from "./labels.js";
import { EDIT_SLICES } from "./metrics/reconciliation.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One constructed edit: a diff, the atom it is checked against, and the slice
 * it was constructed for (docs/12-evaluation.md, §3 *Corpus*).
 *
 * `constructedBy` is recorded because the labeller must not be the person who
 * constructed the example — the author of a near-miss knows it is a near-miss
 * for a reason the system has no access to.
 *
 * The slice is the constructor's intent; the human verdict lives in a separate
 * label set. The two can disagree, and when they do the label wins — a seeded
 * violation that does not actually violate is a construction mistake, not a
 * labelling one.
 */
const Edit = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  slice: z.enum(EDIT_SLICES),
  atom: z.object({
    statement: z.string().min(1),
    kind: z.enum(ATOM_KINDS),
  }),
  /** The path the edit touches — what `reconcile` cites. */
  file: z.string().min(1),
  /** A unified diff. Corpus material, constructed for purpose; never customer code. */
  diff: z.string().min(1),
  constructedBy: z.string().min(1),
  constructedOn: z.string().regex(ISO_DATE),
});

export const EditCorpus = z
  .object({
    version: z.literal(1),
    edits: z.array(Edit).min(1),
  })
  .refine(
    (corpus) =>
      corpus.edits.length === new Set(corpus.edits.map((e) => e.id)).size,
    { message: "duplicate edit id" },
  );

export type Edit = z.infer<typeof Edit>;
export type EditCorpus = z.infer<typeof EditCorpus>;

/** Null when `eval/corpus/edits.json` does not exist — the skip case. */
export function loadEditCorpus(root: string): EditCorpus | null {
  const path = join(root, "corpus", "edits.json");
  if (!existsSync(path)) {
    return null;
  }
  const parsed = EditCorpus.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `corpus/edits.json is not a valid edit corpus:\n${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * A human's verdicts over the edit corpus, at `labels/edits.<labeller>.json`.
 *
 * `expected` is what a correct reconciler does with the edit: `violated` means
 * a finding is right, `no-finding` means any `violated` finding is a false
 * positive. Written blind, before any checking model runs.
 */
export const EditLabelSet = z.object({
  version: z.literal(1),
  labeller: z.string().min(1),
  labelledOn: z.string().regex(ISO_DATE),
  blind: z.boolean(),
  modelAssisted: z.boolean(),
  verdicts: z
    .array(
      z.object({
        edit: z.string().min(1),
        expected: z.enum(["violated", "no-finding"]),
      }),
    )
    .min(1),
});

export type EditLabelSet = z.infer<typeof EditLabelSet>;

export function loadEditLabels(root: string): EditLabelSet[] {
  const directory = join(root, "labels");
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => /^edits\.[^.]+\.json$/.test(name))
    .sort()
    .map((name) => {
      const parsed = EditLabelSet.safeParse(
        JSON.parse(readFileSync(join(directory, name), "utf8")),
      );
      if (!parsed.success) {
        throw new Error(
          `labels/${name} is not a valid edit label set:\n${parsed.error.message}`,
        );
      }
      return parsed.data;
    });
}

/**
 * What a checking session recorded, one file per session, passed to
 * `pnpm eval reconciliation` by path.
 *
 * The checker is not part of this repository: reconciliation is performed by a
 * coding agent with the product's own prompts, and the harness inventing a
 * second checking prompt would measure something no user runs. The file
 * records the model because the false-positive rate is a property of the model
 * doing the check (docs/12-evaluation.md, *Open*).
 */
export const FindingsFile = z.object({
  version: z.literal(1),
  model: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  checkedOn: z.string().regex(ISO_DATE),
  configuration: z.record(z.string(), z.unknown()),
  findings: z
    .array(
      z.object({
        edit: z.string().min(1),
        verdict: z.enum(FINDING_VERDICTS),
      }),
    )
    .min(1),
});

export type FindingsFile = z.infer<typeof FindingsFile>;

/**
 * The minimum finding count below which the rate is not reportable.
 *
 * Required, with no default, on the same pattern as the ratification CLI's
 * `--older-than`: the value is a function of the 5% bar and the interval width
 * the decision can tolerate, a human computes it once the corpus exists, and a
 * harness that defaulted it would have chosen it (docs/12-evaluation.md,
 * *Open*).
 */
export type MinFindings =
  | { kind: "unset" }
  | { kind: "invalid"; raw: string }
  | { kind: "set"; value: number };

export function parseMinFindings(raw: string | undefined): MinFindings {
  if (raw === undefined || raw === "") {
    return { kind: "unset" };
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    return { kind: "invalid", raw };
  }
  return { kind: "set", value: Number(raw) };
}

const Model = z.object({ name: z.string().min(1), version: z.string().min(1) });

/** A committed reconciliation run: the number and everything that reproduces it. */
export const ReconciliationRunFile = z.object({
  version: z.literal(1),
  metric: z.literal("reconciliation_false_positive_rate"),
  ranOn: z.string().regex(ISO_DATE),
  /** Content hash of corpus/edits.json — the corpus this rate was measured on. */
  editCorpusHash: z.string().min(1),
  codeRevision: z.string().min(1),
  /** The checking model, from the findings file. No two runs on different models compare. */
  model: Model,
  configuration: z.record(z.string(), z.unknown()),
  labels: z.object({
    labellers: z.array(z.string().min(1)).min(1),
    blind: z.boolean(),
    modelAssisted: z.boolean(),
  }),
  findingsFile: z.string().min(1),
  score: z.unknown(),
});

export type ReconciliationRunFile = z.infer<typeof ReconciliationRunFile>;

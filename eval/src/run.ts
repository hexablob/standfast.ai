import { z } from "zod";
import { ATOM_KINDS } from "./labels.js";
import { REJECTIONS } from "./metrics/extraction.js";
import { METRICS } from "./metrics/regression.js";

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const Verdict = z.union([
  z.object({
    accepted: z.literal(true),
    matched: z.string().nullable(),
    miscategorised: z.boolean(),
  }),
  z.object({
    accepted: z.literal(false),
    rejection: z.enum(REJECTIONS),
  }),
]);

const AdjudicatedAtom = z.object({
  sectionHash: z.string().regex(HEX64),
  statement: z.string().min(1),
  kind: z.enum(ATOM_KINDS),
  quote: z.string().min(1),

  // Null until a human has adjudicated it. `pnpm eval score` refuses a file
  // with any null left, which is what stops a half-adjudicated worksheet from
  // being reported as a measurement.
  verdict: Verdict.nullable(),
});

const Model = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

/**
 * How many labelled sections of each tier the run actually covered.
 *
 * Required because `slice` alone is a claim and this is the evidence for it.
 * The refinement below uses it to refuse a run that says `all` and only read
 * this repository's own documentation — which `docs/12-evaluation.md` reports
 * separately and never folds into a headline.
 */
const Coverage = z.object({
  self: z.number().int().nonnegative(),
  public: z.number().int().nonnegative(),
  synthetic: z.number().int().nonnegative(),
});

/**
 * One committed run.
 *
 * The fields a number needs to be reproducible are all required and none is
 * derivable from the others: the metric, the corpus revision, the code
 * revision, the models, the extractor version, and the configuration.
 *
 * **Three models, not one.** Phase 1 has an extractor, an embedder and a dedup
 * judge, and each changes the output in a different way — the extractor decides
 * what is proposed, the embedder decides what survives dedup, the judge decides
 * the middle band. A run that recorded "the model" would name whichever one
 * somebody thought was the interesting one.
 *
 * `extractorVersion` is the opaque string that keys `section_extractions`. It
 * is derivable from the three models and the thresholds in principle, and
 * recorded anyway, because it is what joins a number to the rows that produced
 * it — and because the derivation lives in code that will change.
 *
 * The `version` literal stays 1. Nothing was ever written as a v1 run file, so
 * there is nothing to be compatible with; bumping to 2 would imply a v1 exists
 * in the wild and invite somebody to write a migration for it.
 */
export const RunFile = z
  .object({
    version: z.literal(1),
    metric: z.enum(METRICS),
    ranOn: z.string().regex(ISO_DATE),

    corpusRevision: z.string().min(1),
    codeRevision: z.string().min(1),

    models: z.object({
      extraction: Model,
      embedding: Model,
      judge: Model,
    }),

    /** The value in `section_extractions.extractor_version` for these rows. */
    extractorVersion: z.string().min(1),

    configuration: z.record(z.string(), z.unknown()),

    /** Which slice this run covers. `self` is never folded into the headline. */
    slice: z.enum(["self", "public", "synthetic", "all"]),
    coverage: Coverage,
    split: z.enum(["tuning", "held-out"]),

    /**
     * Carried from the label sets that graded this run. A run whose labels were
     * not blind, or were model-assisted, says so here and in its printed
     * summary — that is the whole of the "marked as such" rule.
     */
    labels: z.object({
      labellers: z.array(z.string().min(1)).min(1),
      blind: z.boolean(),
      modelAssisted: z.boolean(),
    }),

    /** Recall's denominator: every expected atom of every processed section. */
    expectedAtomIds: z.array(z.string().min(1)),

    adjudications: z.array(AdjudicatedAtom),

    /** Written by `pnpm eval score`. Null on a freshly emitted worksheet. */
    score: z.unknown().nullable(),
  })
  .refine(
    (run) => run.coverage[run.slice === "all" ? "self" : run.slice] >= 0,
    {
      message: "coverage must be present for the declared slice",
    },
  )
  .refine(
    (run) => {
      const { self, public: pub, synthetic } = run.coverage;
      const total = self + pub + synthetic;
      if (total === 0) return false;
      switch (run.slice) {
        // The guard this schema exists for. `all` is the headline slice, and
        // docs/12-evaluation.md reports the self tier separately and never
        // folds it in — so a run over nothing but this repository's own
        // documentation may not call itself `all`. Structural rather than a
        // convention somebody has to remember, because the first run is the
        // one that sets a bar and the bar only tightens afterwards.
        case "all":
          return pub + synthetic > 0;
        case "self":
          return self > 0 && pub + synthetic === 0;
        case "public":
          return pub > 0 && self + synthetic === 0;
        case "synthetic":
          return synthetic > 0 && self + pub === 0;
      }
    },
    {
      message:
        "slice disagrees with coverage: a run over only the self tier cannot be reported as `all` (docs/12-evaluation.md), and a single-tier slice must cover that tier and no other",
    },
  );

export type RunFile = z.infer<typeof RunFile>;
export type AdjudicatedAtomRecord = z.infer<typeof AdjudicatedAtom>;

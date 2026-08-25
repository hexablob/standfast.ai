import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentExtractorVersion } from "@standfast/core";
import { resolvePorts } from "@standfast/worker";
import { agreements } from "./agreement.js";
import { checkCorpus, loadCorpus, type Problem } from "./corpus.js";
import {
  checkLabels,
  coverage,
  expectedAtomId,
  labelFileName,
  loadLabels,
} from "./labels.js";
import { scoreExtraction } from "./metrics/extraction.js";
import { Baselines, compareToBaseline } from "./metrics/regression.js";
import { failure, heading, line, skipped, warning } from "./output.js";
import { databaseAvailable, extractorAvailable } from "./preconditions.js";
import { RunFile } from "./run.js";
import { evalDatabaseUrl, runExtraction } from "./runner.js";
import { labelSkeleton } from "./skeleton.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `pnpm eval <command>

  check                       corpus integrity, label validity, coverage
  skeleton <document> <who>   write a blank label set for a corpus document
  score <run-file>            compute the metrics of an adjudicated run
  extraction                  run the extractor over the corpus
  retrieval                   run the labelled queries under the token budget
  reconciliation              measure the reconciler's false-positive rate

Everything deterministic runs everywhere. Anything that needs a model or a
database skips loudly rather than reporting a pass it did not earn.
`;

function report(problems: Problem[]): number {
  let errors = 0;
  for (const problem of problems) {
    if (problem.level === "error") {
      errors += 1;
      failure(problem.message);
    } else {
      warning(problem.message);
    }
  }
  return errors;
}

function check(): number {
  const corpus = loadCorpus(ROOT);
  const labels = loadLabels(ROOT);

  heading(`Corpus ${corpus.revision}`);
  for (const document of corpus.documents) {
    line(
      `  ${document.id.padEnd(26)} ${String(document.sections.length).padStart(3)} sections  ${document.tier}/${document.split}`,
    );
  }

  heading("Coverage");
  if (labels.length === 0) {
    line("  No label sets. The corpus is not a labelled corpus yet.");
    line("  Start one: pnpm eval skeleton <document> <labeller>");
  }
  for (const row of coverage(corpus, labels)) {
    if (row.labellers.length === 0) {
      line(`  ${row.document.padEnd(26)} unlabelled`);
      continue;
    }
    for (const by of row.labellers) {
      const percent = Math.round((by.labelled / row.sections) * 100);
      line(
        `  ${row.document.padEnd(26)} ${by.labeller.padEnd(10)} ${by.labelled}/${row.sections} (${percent}%)`,
      );
    }
  }

  const pairs = agreements(labels);
  heading("Inter-labeller agreement");
  if (pairs.length === 0) {
    line("  Nothing double-labelled. A precision figure without an agreement");
    line("  figure beside it is a statement about one person's taste.");
  }
  for (const pair of pairs) {
    const jaccard =
      pair.quoteJaccard === null ? "n/a" : pair.quoteJaccard.toFixed(2);
    line(
      `  ${pair.document} ${pair.pair.join(" vs ")}: ${pair.overlap} shared sections, ` +
        `emptiness ${pair.emptiness.agreed}/${pair.emptiness.of}, ` +
        `count ${pair.count.agreed}/${pair.count.of}, quote jaccard ${jaccard}`,
    );
  }

  heading("Problems");
  const errors = report([
    ...checkCorpus(corpus),
    ...checkLabels(corpus, labels),
  ]);
  if (errors === 0) {
    line("  No errors.");
  }
  return errors === 0 ? 0 : 1;
}

function skeleton(
  documentId: string | undefined,
  labeller: string | undefined,
): number {
  if (!documentId || !labeller) {
    process.stderr.write("usage: pnpm eval skeleton <document> <labeller>\n");
    return 2;
  }

  const corpus = loadCorpus(ROOT);
  const document = corpus.documents.find((d) => d.id === documentId);
  if (!document) {
    failure(`no corpus document with id ${documentId}`);
    return 1;
  }

  const path = join(ROOT, "labels", labelFileName(documentId, labeller));
  if (existsSync(path)) {
    failure(`${path} already exists — refusing to overwrite a label set`);
    return 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path,
    `${JSON.stringify(labelSkeleton(document, labeller, today), null, 2)}\n`,
    "utf8",
  );

  line(`Wrote ${path} — ${document.sections.length} sections.`);
  line();
  line(`Read eval/corpus/${document.file} and fill in 'expect' for each`);
  line("section. Leave it empty to say the section states nothing. Delete the");
  line("entries you have not reached — absence is what 'unlabelled' means.");
  line();
  line("Do not look at the extractor's output first. That is the method, not");
  line("a nicety: grading anchors on what is present and cannot notice what");
  line("is absent.");
  return 0;
}

function score(path: string | undefined): number {
  if (!path) {
    process.stderr.write("usage: pnpm eval score <run-file>\n");
    return 2;
  }

  const run = RunFile.parse(JSON.parse(readFileSync(path, "utf8")));

  const pending = run.adjudications.filter((a) => a.verdict === null).length;
  if (pending > 0) {
    failure(
      `${pending} of ${run.adjudications.length} atoms are not adjudicated. ` +
        "A half-adjudicated worksheet is not a measurement.",
    );
    return 1;
  }

  const adjudicated = run.adjudications.flatMap((atom) =>
    atom.verdict === null ? [] : [{ ...atom, verdict: atom.verdict }],
  );
  const result = scoreExtraction(adjudicated, run.expectedAtomIds);

  heading(`${run.metric} — slice ${run.slice}, split ${run.split}`);
  line(`  corpus ${run.corpusRevision}  code ${run.codeRevision}`);
  // All three, always. A reader deciding whether two numbers are comparable
  // needs to see which of them moved, and the version string is what joins the
  // number to the section_extractions rows behind it.
  line(
    `  extract  ${run.models.extraction.name} ${run.models.extraction.version}`,
  );
  line(
    `  embed    ${run.models.embedding.name} ${run.models.embedding.version}`,
  );
  line(`  judge    ${run.models.judge.name} ${run.models.judge.version}`);
  line(`  version  ${run.extractorVersion}`);
  line(
    `  coverage self ${run.coverage.self}, public ${run.coverage.public}, synthetic ${run.coverage.synthetic}`,
  );
  if (!run.labels.blind || run.labels.modelAssisted) {
    line(
      `  CONTAMINATED: blind=${run.labels.blind} modelAssisted=${run.labels.modelAssisted}`,
    );
  }
  line();
  line(
    `  precision      ${result.precision} (${result.accepted}/${result.emitted})`,
  );
  line(`  unsupported    ${result.rejections.unsupported}`);
  line(`  not knowledge  ${result.rejections["not-knowledge"]}`);
  line(`  duplicate      ${result.rejections.duplicate}`);
  line(
    `  miscategorised ${result.miscategorised.count} (reported, not a precision failure)`,
  );
  line(
    `  recall         ${result.recall.rate} (${result.recall.matched}/${result.recall.expected})`,
  );
  line();

  if (run.slice === "self") {
    line(
      "  Slice 'self' is this repository's own documents — written by people",
    );
    line("  who know what an atom is. Reported on its own, never folded into");
    line("  the headline.");
    line();
  }

  writeFileSync(
    path,
    `${JSON.stringify({ ...run, score: result }, null, 2)}\n`,
    "utf8",
  );

  if (!result.gate.passed) {
    failure(
      `${result.gate.unsupported} unsupported atom(s). This is a gate failure, ` +
        "not a low score: phase 1's exit criterion 1 is false.",
    );
    return 1;
  }

  const baselines = Baselines.parse(
    JSON.parse(readFileSync(join(ROOT, "baselines.json"), "utf8")),
  );
  const entry = baselines.metrics[run.metric];
  if (result.precision === null) {
    warning("nothing was emitted — there is no precision to compare");
    return 0;
  }

  const comparison = compareToBaseline(result.precision, entry);
  line(`  ${comparison.status.toUpperCase()}: ${comparison.reason}`);
  return comparison.fails ? 1 : 0;
}

async function extraction(): Promise<number> {
  const corpus = loadCorpus(ROOT);
  const labels = loadLabels(ROOT);

  const precondition = extractorAvailable();
  if (!precondition.met) {
    heading("extraction_precision");
    skipped("extraction_precision", precondition.reason);
    line();
    line("  What the harness is holding for it, ready:");
    line(
      `    corpus     ${corpus.documents.length} documents, revision ${corpus.revision}`,
    );
    line(`    labels     ${labels.length} set(s)`);
    line(
      `    expected   ${labels.reduce(
        (total, set) =>
          total +
          set.sections.reduce(
            (n, section) =>
              n +
              section.expect.map((_, i) => expectedAtomId(section, i)).length,
            0,
          ),
        0,
      )} atoms`,
    );
    return 0;
  }

  // The runner writes to its own database, drives the pipeline in a fixed
  // order, and emits a worksheet with every verdict null. Scoring is a person
  // reading each atom against the labels — a command that filled that in would
  // be the system grading itself.
  // Tuning by default. The held-out split is spent the first time it is
  // measured, so reaching it has to be deliberate (docs/12-evaluation.md,
  // contamination rule 3).
  const split = (process.env["STANDFAST_EVAL_SPLIT"] ?? "tuning") as
    | "tuning"
    | "held-out";
  const slice = (process.env["STANDFAST_EVAL_SLICE"] ?? "all") as
    | "self"
    | "public"
    | "synthetic"
    | "all";

  const url = evalDatabaseUrl();
  const ports = resolvePorts().ports;
  const version = currentExtractorVersion();

  const result = await runExtraction({
    corpus,
    labels,
    slice,
    split,
    extractorVersion: version,
    ports,
    databaseUrl: url,
  });

  const worksheet = {
    version: 1 as const,
    metric: "extraction_precision" as const,
    ranOn: new Date().toISOString().slice(0, 10),
    corpusRevision: corpus.revision,
    codeRevision: process.env["STANDFAST_EVAL_CODE_REVISION"] ?? "unknown",
    models: {
      extraction: { name: ports.extractor.id, version },
      embedding: { name: ports.embedder.id, version },
      judge: { name: ports.judge.id, version },
    },
    extractorVersion: version,
    configuration: {},
    slice,
    coverage: result.coverage,
    split,
    labels: {
      labellers: [...new Set(labels.map((set) => set.labeller))],
      blind: labels.every((set) => set.blind),
      modelAssisted: labels.some((set) => set.modelAssisted),
    },
    expectedAtomIds: result.expectedAtomIds,
    adjudications: result.adjudications,
    score: null,
  };

  // Validated before it is written. A worksheet that the schema would refuse is
  // a worksheet somebody spends an afternoon scoring and then cannot commit —
  // and the slice guard in particular fires on exactly the corpus shape a first
  // run is most likely to have.
  const parsed = RunFile.safeParse(worksheet);
  if (!parsed.success) {
    failure(
      `the run this produced is not a valid run file:\n  ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n  ")}`,
    );
    return 1;
  }

  const target = join(
    ROOT,
    "runs",
    `${worksheet.ranOn}-extraction-${slice}.json`,
  );
  writeFileSync(target, `${JSON.stringify(worksheet, null, 2)}\n`);

  heading("extraction_precision");
  line(`  extracted  ${result.adjudications.length} atom(s)`);
  line(`  expected   ${result.expectedAtomIds.length} atom(s) from labels`);
  line(
    `  coverage   self ${result.coverage.self}, public ${result.coverage.public}, synthetic ${result.coverage.synthetic}`,
  );
  line(`  worksheet  ${target}`);
  line();
  line("  Every verdict is null. Adjudicate them by hand, then:");
  line(`    pnpm eval score ${target}`);
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "check":
      return check();
    case "skeleton":
      return skeleton(rest[0], rest[1]);
    case "score":
      return score(rest[0]);
    case "extraction":
      return await extraction();
    case "retrieval": {
      const precondition = databaseAvailable(process.env);
      heading("retrieval_precision_under_budget");
      skipped(
        "retrieval_precision_under_budget",
        precondition.met
          ? "phase 2 owns retrieval; there are no labelled queries yet"
          : precondition.reason,
      );
      return 0;
    }
    case "reconciliation": {
      // Unconditional, where `retrieval` at least consults a precondition:
      // there is nothing here a precondition could check. A database and three
      // real ports would not make this measurable, because what is missing is
      // a corpus of edits and the person who marked which findings on it were
      // wrong. And `reconciliation_false_positive_rate` is the one metric in
      // `baselines.json` carrying `barIsHardThreshold` — the first number this
      // command ever prints is a number the product can be killed by, so it
      // waits for the labeller rather than meeting them halfway.
      heading("reconciliation_false_positive_rate");
      skipped(
        "reconciliation_false_positive_rate",
        "phase 3 owns reconciliation; no corpus of edits exists and nobody has labelled one. The bar is 5% and it is a hard threshold, so a number produced without a human labeller would measure how hard someone tried, not whether the reconciler works",
      );
      return 0;
    }
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`unknown command '${command}'\n\n${USAGE}`);
      return 2;
  }
}

// Only the process this file *is* runs the CLI. `main` is exported so a test
// can drive one command and read the code it returns; without the guard the
// import alone would run the CLI against the test runner's argv and set an exit
// code out from under it.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // A thrown error here is a runner refusal — an unlabelled slice, a
      // database it will not write to. Reported as a failure with its own
      // message rather than a stack, because the message is the instruction.
      failure(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

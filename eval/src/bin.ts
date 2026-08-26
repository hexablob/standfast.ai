import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, currentExtractorVersion } from "@standfast/core";
import { resolvePorts } from "@standfast/worker";
import { agreements } from "./agreement.js";
import { checkCorpus, loadCorpus, type Problem } from "./corpus.js";
import {
  FindingsFile,
  loadEditCorpus,
  loadEditLabels,
  parseMinFindings,
  ReconciliationRunFile,
} from "./edits.js";
import {
  checkLabels,
  coverage,
  expectedAtomId,
  labelFileName,
  loadLabels,
} from "./labels.js";
import {
  boundProviders,
  DEFAULT_ATOMS,
  DEFAULT_ITERATIONS,
  DEFAULT_WARMUP,
  LatencyRunFile,
  NOT_A_CONTRACT,
  runLatency,
  scaleFor,
} from "./latency.js";
import { scoreExtraction } from "./metrics/extraction.js";
import {
  type Distribution,
  distribution,
  trimWarmup,
} from "./metrics/latency.js";
import {
  type EditExpectation,
  scoreReconciliation,
} from "./metrics/reconciliation.js";
import { Baselines, compareToBaseline } from "./metrics/regression.js";
import { type BudgetScore, scoreRetrieval } from "./metrics/retrieval.js";
import { failure, heading, line, skipped, warning } from "./output.js";
import { extractorAvailable } from "./preconditions.js";
import { loadQuerySets, RetrievalRunFile } from "./queries.js";
import { READ_PATH, runRetrieval } from "./retrieval.js";
import { RunFile } from "./run.js";
import { evalDatabaseUrl, runExtraction } from "./runner.js";
import { labelSkeleton } from "./skeleton.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `pnpm eval <command>

  check                       corpus integrity, label validity, coverage
  skeleton <document> <who>   write a blank label set for a corpus document
  score <run-file>            compute the metrics of an adjudicated run
  extraction                  run the extractor over the corpus
  retrieval <scored-run>      run the labelled queries at each committed budget
  reconciliation <findings>   score a checking session against the edit corpus
  latency                     time the context tool over a synthetic corpus

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
  // Zero, because the command did the whole of its job: a worksheet awaiting a
  // human is what success looks like here. `docs/12-evaluation.md` reserves 1
  // for a failure or a regression, and either can still arrive — from `score`,
  // once the verdicts are in.
  return 0;
}

async function retrieval(runPath: string | undefined): Promise<number> {
  const name = "retrieval_precision_under_budget" as const;
  heading(name);

  const querySets = loadQuerySets(ROOT);
  if (querySets.length === 0) {
    skipped(
      name,
      "no labelled queries exist. A human writes eval/queries/<labeller>.json " +
        "— task or file-path queries, the expected-atom ids that govern each, " +
        "and at least three budgets — from the code and the task, never from " +
        "the atom list (docs/12-evaluation.md, §2)",
    );
    return 0;
  }

  const precondition = extractorAvailable();
  if (!precondition.met) {
    skipped(name, precondition.reason);
    return 0;
  }

  if (!runPath) {
    process.stderr.write(
      "usage: pnpm eval retrieval <scored-extraction-run>\n\n" +
        "Retrieval serves ratified atoms, and ratified means a human accepted\n" +
        "them: pass the adjudicated extraction run whose accepted atoms this\n" +
        "run may treat as canonical.\n",
    );
    return 2;
  }

  const scored = RunFile.parse(JSON.parse(readFileSync(runPath, "utf8")));
  const pending = scored.adjudications.filter((a) => a.verdict === null).length;
  if (pending > 0) {
    failure(
      `${runPath} has ${pending} unadjudicated atom(s). Ratified atoms are ` +
        "this metric's corpus, and only a human adjudication says which those are.",
    );
    return 1;
  }

  const corpus = loadCorpus(ROOT);
  const labels = loadLabels(ROOT);
  const url = evalDatabaseUrl();
  const ports = resolvePorts().ports;
  const version = currentExtractorVersion();

  const result = await runRetrieval({
    corpus,
    labels,
    querySets,
    scored,
    extractorVersion: version,
    ports,
    databaseUrl: url,
  });

  const totalQueries = querySets.reduce((n, s) => n + s.queries.length, 0);
  const paraphrasedCount = querySets.reduce(
    (n, s) => n + s.queries.filter((q) => q.paraphrased).length,
    0,
  );
  const blind = querySets.every((s) => s.blind);
  const modelAssisted = querySets.some((s) => s.modelAssisted);

  line(
    `  queries    ${totalQueries} (${paraphrasedCount} paraphrased) from ${querySets.length} set(s)`,
  );
  line(
    `  atoms      ${result.ratified} ratified from ${result.acceptedInRun} accepted in the scored run`,
  );
  line(
    "  reranker   fused-only — no provider is bound; the reranked regime awaits one",
  );
  if (result.unmatchedAdjudications > 0) {
    warning(
      `${result.unmatchedAdjudications} accepted adjudication(s) matched no ` +
        "freshly extracted atom — the extractor drifted from the scored run, " +
        "and the ratified set is partial",
    );
  }
  if (result.unrealisedGoverning > 0) {
    line(
      `  governing  ${result.unrealisedGoverning} labelled governing atom(s) never became canonical — an extraction recall failure, measured there, not displacement`,
    );
  }
  if (!blind || modelAssisted) {
    line(`  CONTAMINATED: blind=${blind} modelAssisted=${modelAssisted}`);
  }

  if (result.budgetViolations.length > 0) {
    failure(
      `${result.budgetViolations.length} pack(s) exceeded their budget — ` +
        `${result.budgetViolations.slice(0, 5).join(", ")}. The budget is a ` +
        "gate, not a measurement (docs/14-roadmap.md, phase 2 criterion 1).",
    );
    return 1;
  }

  const score = scoreRetrieval(result.records);
  const printCurve = (rows: BudgetScore[]): void => {
    for (const row of rows) {
      const precision =
        row.precision === null ? "n/a  " : row.precision.toFixed(3);
      line(
        `    ${String(row.budgetTokens).padStart(6)}  precision ${precision}  delivered ${row.delivered}  displaced ${row.displacement}  used(max) ${row.budgetTokensUsedMax}`,
      );
    }
  };
  line();
  line("  precision under budget (pooled):");
  printCurve(score.budgets);
  if (score.paraphrased.length > 0) {
    line("  paraphrased slice:");
    printCurve(score.paraphrased);
  }

  const run = {
    version: 1 as const,
    metric: name,
    ranOn: new Date().toISOString().slice(0, 10),
    corpusRevision: corpus.revision,
    codeRevision: process.env["STANDFAST_EVAL_CODE_REVISION"] ?? "unknown",
    models: {
      extraction: { name: ports.extractor.id, version },
      embedding: { name: ports.embedder.id, version },
      judge: { name: ports.judge.id, version },
    },
    extractorVersion: version,
    configuration: { ...READ_PATH },
    reranker: "fused-only" as const,
    scoredRun: runPath,
    labels: {
      labellers: [...new Set(querySets.map((s) => s.labeller))],
      blind,
      modelAssisted,
    },
    budgets: [...new Set(querySets.flatMap((s) => s.budgets))].sort(
      (a, b) => a - b,
    ),
    queryCount: totalQueries,
    ratifiedAtoms: result.ratified,
    score,
  };
  const parsed = RetrievalRunFile.safeParse(run);
  if (!parsed.success) {
    failure(
      `the run this produced is not a valid run file:\n  ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n  ")}`,
    );
    return 1;
  }
  const target = join(ROOT, "runs", `${run.ranOn}-retrieval.json`);
  writeFileSync(target, `${JSON.stringify(run, null, 2)}\n`);
  line();
  line(`  run        ${target}`);

  const baselines = Baselines.parse(
    JSON.parse(readFileSync(join(ROOT, "baselines.json"), "utf8")),
  );
  const entry = baselines.metrics[name];
  const gatable = score.budgets.filter((row) => row.precision !== null);
  if (gatable.length === 0) {
    warning(
      "nothing was delivered at any budget — there is no precision to compare",
    );
    return 0;
  }
  if (entry.baseline === null || entry.noiseBand === null) {
    const comparison = compareToBaseline(gatable[0]?.precision ?? 0, entry);
    line(`  ${comparison.status.toUpperCase()}: ${comparison.reason}`);
    return comparison.fails ? 1 : 0;
  }
  // The pair (precision, budget) is the unit, and the committed baseline is a
  // single number: until it records its budget, every point on the curve is
  // gated, because failing any point is the only reading that does not quietly
  // choose one.
  let failed = false;
  for (const row of gatable) {
    const comparison = compareToBaseline(row.precision ?? 0, entry);
    line(
      `  budget ${row.budgetTokens}: ${comparison.status.toUpperCase()} — ${comparison.reason}`,
    );
    if (comparison.fails) {
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

function reconciliation(findingsPath: string | undefined): number {
  const name = "reconciliation_false_positive_rate" as const;
  heading(name);

  const editCorpus = loadEditCorpus(ROOT);
  if (editCorpus === null) {
    skipped(
      name,
      "no corpus of edits exists. A human constructs eval/corpus/edits.json " +
        "— seeded violations, seeded near-misses, innocent edits, legitimate " +
        "drift — and a different human labels it blind " +
        "(docs/12-evaluation.md, §3). The bar is 5% and it is a hard " +
        "threshold, so a number produced without that corpus would measure " +
        "how hard someone tried, not whether the reconciler works",
    );
    return 0;
  }

  const labelSets = loadEditLabels(ROOT);
  if (labelSets.length === 0) {
    skipped(
      name,
      "the edit corpus exists and nobody has labelled it. A human who did " +
        "not construct the edits writes eval/labels/edits.<labeller>.json — " +
        "one verdict per edit, blind, before any checking model runs",
    );
    return 0;
  }

  const min = parseMinFindings(process.env["STANDFAST_EVAL_MIN_FINDINGS"]);
  if (min.kind === "unset") {
    skipped(
      name,
      "STANDFAST_EVAL_MIN_FINDINGS is not set. The minimum finding count " +
        "below which the rate is unreportable is a function of the 5% bar " +
        "and the interval width the decision can tolerate; a human computes " +
        "it from the corpus and provides it, and the harness refuses to " +
        "default it (docs/12-evaluation.md, Open)",
    );
    return 0;
  }
  if (min.kind === "invalid") {
    process.stderr.write(
      `STANDFAST_EVAL_MIN_FINDINGS must be a positive integer (got '${min.raw}')\n`,
    );
    return 2;
  }

  if (!findingsPath) {
    process.stderr.write(
      "usage: pnpm eval reconciliation <findings-file>\n\n" +
        "The checker is a coding agent running the product's own prompts, not\n" +
        "this harness. Record its findings — one {edit, verdict} per corpus\n" +
        "edit, with the checking model's name and version — and pass that file.\n",
    );
    return 2;
  }

  const findings = FindingsFile.parse(
    JSON.parse(readFileSync(findingsPath, "utf8")),
  );

  const known = new Set(editCorpus.edits.map((edit) => edit.id));
  const merged = new Map<string, "violated" | "no-finding">();
  for (const set of labelSets) {
    for (const verdict of set.verdicts) {
      if (!known.has(verdict.edit)) {
        failure(
          `labels/edits.${set.labeller}.json labels '${verdict.edit}', which is not an edit in the corpus`,
        );
        return 1;
      }
      const existing = merged.get(verdict.edit);
      if (existing !== undefined && existing !== verdict.expected) {
        failure(
          `edit '${verdict.edit}' is labelled '${existing}' by one labeller ` +
            `and '${verdict.expected}' by another. Humans adjudicate a ` +
            "disagreement; the harness does not average one.",
        );
        return 1;
      }
      merged.set(verdict.edit, verdict.expected);
    }
  }

  const expectations: EditExpectation[] = [];
  const unlabelled: string[] = [];
  for (const edit of editCorpus.edits) {
    const expected = merged.get(edit.id);
    if (expected === undefined) {
      unlabelled.push(edit.id);
    } else {
      expectations.push({ id: edit.id, slice: edit.slice, expected });
    }
  }
  if (unlabelled.length > 0) {
    failure(
      `${unlabelled.length} edit(s) have no verdict, so a finding on them ` +
        `could not be scored: ${unlabelled.slice(0, 10).join(", ")}`,
    );
    return 1;
  }

  const score = scoreReconciliation(expectations, findings.findings);
  const blind = labelSets.every((set) => set.blind);
  const modelAssisted = labelSets.some((set) => set.modelAssisted);

  line(`  edits          ${score.edits}`);
  line(
    `  findings       ${score.findings} recorded, ${score.emitted} with verdict 'violated'`,
  );
  line(`  model          ${findings.model.name} ${findings.model.version}`);
  if (!blind || modelAssisted) {
    line(`  CONTAMINATED: blind=${blind} modelAssisted=${modelAssisted}`);
  }
  line();
  for (const [slice, row] of Object.entries(score.perSlice)) {
    line(
      `    ${slice.padEnd(18)} edits ${row.edits}, violated findings ${row.emitted}, false positives ${row.falsePositives}, misses ${row.misses}`,
    );
  }
  line();
  // Beside the headline, never optimised: the degenerate optimum of a kill
  // metric is silence, and a reconciler that emits nothing scores zero.
  line(
    `  misses         ${score.misses} (rate ${score.missRate === null ? "n/a" : score.missRate.toFixed(3)})`,
  );

  const run = {
    version: 1 as const,
    metric: name,
    ranOn: new Date().toISOString().slice(0, 10),
    editCorpusHash: contentHash(
      readFileSync(join(ROOT, "corpus", "edits.json"), "utf8"),
    ),
    codeRevision: process.env["STANDFAST_EVAL_CODE_REVISION"] ?? "unknown",
    model: findings.model,
    configuration: { minFindings: min.value },
    labels: {
      labellers: [...new Set(labelSets.map((set) => set.labeller))],
      blind,
      modelAssisted,
    },
    findingsFile: findingsPath,
    score: { ...score, reported: score.emitted >= min.value },
  };
  const parsed = ReconciliationRunFile.safeParse(run);
  if (!parsed.success) {
    failure(
      `the run this produced is not a valid run file:\n  ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n  ")}`,
    );
    return 1;
  }
  const target = join(ROOT, "runs", `${run.ranOn}-reconciliation.json`);
  writeFileSync(target, `${JSON.stringify(run, null, 2)}\n`);
  line(`  run            ${target}`);
  line();

  if (score.emitted < min.value) {
    line(
      `  rate withheld: ${score.emitted} 'violated' finding(s) is below the ` +
        `minimum of ${min.value} (STANDFAST_EVAL_MIN_FINDINGS). At low counts ` +
        "the rate is unstable — one bad finding out of eight is 12.5% — so " +
        "the counts above are reported and the rate is not. Grow the corpus, " +
        "or record a longer checking session.",
    );
    return 0;
  }

  const rate = score.rate;
  const interval = score.interval;
  if (rate === null || interval === null) {
    // Unreachable while the minimum is at least one; kept to keep types honest.
    warning("nothing was emitted — there is no rate to compare");
    return 0;
  }
  line(
    `  false-positive rate ${rate.toFixed(4)} (${score.falsePositives}/${score.emitted}), 95% CI ${interval.low.toFixed(4)}–${interval.high.toFixed(4)}`,
  );

  const baselines = Baselines.parse(
    JSON.parse(readFileSync(join(ROOT, "baselines.json"), "utf8")),
  );
  const comparison = compareToBaseline(rate, baselines.metrics[name]);
  line(`  ${comparison.status.toUpperCase()}: ${comparison.reason}`);
  return comparison.fails ? 1 : 0;
}

/** The commit, if git is cheaply reachable. "unknown" beats a thrown stack. */
function gitRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

function row(label: string, summary: Distribution): void {
  const ms = (value: number) => `${value.toFixed(1)}`.padStart(8);
  line(
    `  ${label.padEnd(10)} n=${String(summary.n).padStart(4)}  min${ms(summary.min)}  p50${ms(summary.p50)}  p90${ms(summary.p90)}  p95${ms(summary.p95)}  p99${ms(summary.p99)}  max${ms(summary.max)}`,
  );
}

/**
 * Times `context` and reports the distribution. It compares against nothing.
 *
 * `docs/14-roadmap.md` owns the p95 contract and has not chosen its value, so
 * this command has no failure mode that depends on how fast the run was. It
 * returns 0 whether the p95 was two milliseconds or two seconds; the only
 * non-zero exit is an operational one.
 */
async function latency(): Promise<number> {
  const name = "context_latency" as const;
  heading(name);

  if (!process.env["STANDFAST_EVAL_DATABASE_URL"]) {
    skipped(
      name,
      "STANDFAST_EVAL_DATABASE_URL is not set. This runner creates an org, a " +
        "project and thousands of atoms, so like every other runner it " +
        "populates its own database and deliberately has no path to " +
        "DATABASE_URL. Point it at an empty, migrated database",
    );
    return 0;
  }
  // Still called, for its second refusal: an eval URL equal to the one
  // something else serves from.
  const url = evalDatabaseUrl();

  const scale = scaleFor(
    positiveInt(process.env["STANDFAST_EVAL_LATENCY_ATOMS"], DEFAULT_ATOMS),
  );
  const iterations = positiveInt(
    process.env["STANDFAST_EVAL_LATENCY_ITERATIONS"],
    DEFAULT_ITERATIONS,
  );
  const warmup = nonNegativeInt(
    process.env["STANDFAST_EVAL_LATENCY_WARMUP"],
    DEFAULT_WARMUP,
  );

  // The API connects as an unprivileged role so RLS is enforced exactly as it
  // is in production; the same database, a different login.
  const appUrl = new URL(url);
  appUrl.username = "standfast_test";
  appUrl.password = "standfast_test";

  const providers = boundProviders();

  line(
    `  corpus     ${scale.atoms} canonical atoms in ${scale.documents} document(s),`,
  );
  line(
    `             ${scale.sectionsPerDocument} section(s) each, random unit-vector embeddings`,
  );
  line(
    `  sampling   ${iterations} iteration(s), first ${warmup} discarded as warm-up`,
  );
  line(`  embedding  ${providers.queryEmbedding}`);
  line(`  reranker   ${providers.reranker}`);
  line();
  line("  seeding and measuring…");

  const result = await runLatency({
    databaseUrl: url,
    appDatabaseUrl: appUrl.toString(),
    scale,
    iterations,
    warmup,
  });

  const tool = distribution(trimWarmup(result.tool.samples, warmup));
  const route = distribution(trimWarmup(result.route.samples, warmup));
  if (!tool || !route) {
    // Unreachable: trimWarmup throws before it can empty a sample.
    failure("no samples survived the warm-up");
    return 1;
  }

  heading("milliseconds, nearest-rank percentiles, no mean");
  row("tool", tool);
  row("route", route);
  line(
    `  the delta — tool p50 ${(tool.p50 - route.p50).toFixed(1)}ms, p95 ${(tool.p95 - route.p95).toFixed(1)}ms — is the`,
  );
  line("  MCP server, the typed client, the envelope and the transport.");
  line();
  line(
    `  pack       ${result.packedAtoms} item(s) from ${result.totalCandidates} candidate(s)`,
  );
  line(
    `  skipped    ${result.skippedStages.length > 0 ? result.skippedStages.join(", ") : "nothing"}`,
  );
  if (!providers.real) {
    line();
    warning(
      "no real provider was bound. The query embedder is absent, so generator 1 " +
        "never ran and neither a provider round trip nor the HNSW traversal is in " +
        "these figures. This is a FLOOR, not a forecast, and it must not be " +
        "presented as what a deployment with providers bound would see.",
    );
  }

  const run = {
    version: 1 as const,
    metric: name,
    ranOn: new Date().toISOString().slice(0, 10),
    codeRevision: process.env["STANDFAST_EVAL_CODE_REVISION"] ?? gitRevision(),
    scale: { ...scale, embeddings: "random-unit-vectors" as const },
    sampling: {
      iterations,
      warmup,
      percentileDefinition: "nearest-rank" as const,
    },
    providers: {
      queryEmbedding: providers.queryEmbedding,
      reranker: providers.reranker,
      realProvidersBound: providers.real,
    },
    skippedStages: result.skippedStages,
    pack: {
      itemsInLastPack: result.packedAtoms,
      candidatesInLastPack: result.totalCandidates,
    },
    milliseconds: { tool, route },
    notAContract: NOT_A_CONTRACT,
  };

  const parsed = LatencyRunFile.safeParse(run);
  if (!parsed.success) {
    failure(
      `the run this produced is not a valid run file:\n  ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n  ")}`,
    );
    return 1;
  }
  const target = join(ROOT, "runs", `${run.ranOn}-latency-${scale.atoms}.json`);
  writeFileSync(target, `${JSON.stringify(run, null, 2)}\n`);
  line();
  line(`  run        ${target}`);

  heading("this is not a contract");
  for (const sentence of NOT_A_CONTRACT.split(". ")) {
    line(`  ${sentence.trim().replace(/\.$/, "")}.`);
  }
  return 0;
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
    case "retrieval":
      return await retrieval(rest[0]);
    case "reconciliation":
      return reconciliation(rest[0]);
    case "latency":
      return await latency();
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

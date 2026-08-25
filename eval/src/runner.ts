import { sectionHash } from "@standfast/core";
import {
  createProject,
  putDocument,
  type SectionExtractJob,
  withActor,
} from "@standfast/db";
import { makeSectionExtractHandler } from "@standfast/worker";
import { Client } from "pg";
import type { Corpus, LoadedDocument } from "./corpus.js";
import type { LabelSet } from "./labels.js";
import { expectedAtomId } from "./labels.js";
import type { AdjudicatedAtomRecord, RunFile } from "./run.js";

/**
 * Drives the extraction pipeline over the corpus and emits a run nobody has
 * scored yet.
 *
 * **It populates its own database and has no path to any other.** It reads
 * `STANDFAST_EVAL_DATABASE_URL` rather than `DATABASE_URL`, and refuses when the
 * two are equal — `docs/12-evaluation.md` promises the corpus contains no
 * customer documents and that the runner has "no code path that reads from a
 * production database, and no configuration that would give it one". Reading a
 * different variable is what makes that a mechanism instead of a promise: a
 * production URL reaches this code only if somebody deliberately copies it into
 * an eval-specific name.
 *
 * It emits **adjudications with a null verdict**. Scoring is a human reading
 * each atom against the labels, and a runner that filled that in would be the
 * system grading itself.
 */

export class RunnerError extends Error {}

/** The database this runner is allowed to write to. */
export function evalDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env["STANDFAST_EVAL_DATABASE_URL"];
  if (!url) {
    throw new RunnerError(
      "STANDFAST_EVAL_DATABASE_URL is not set. The runner populates its own database and deliberately does not read DATABASE_URL.",
    );
  }
  if (env["DATABASE_URL"] && env["DATABASE_URL"] === url) {
    throw new RunnerError(
      "STANDFAST_EVAL_DATABASE_URL is the same as DATABASE_URL. The runner creates orgs, projects and documents; it must not do that in a database anything else serves from.",
    );
  }
  return url;
}

/** One org, one extractor actor, one project, created for this run alone. */
async function seedTenant(url: string): Promise<{
  orgId: string;
  actorId: string;
  extractorId: string;
}> {
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    const org = await admin.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $2) returning id",
      ["eval", `eval-${Date.now()}-${process.pid}`],
    );
    const orgId = org.rows[0]?.id ?? "";

    const human = await admin.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', 'eval') returning id",
      [orgId],
    );
    // Created here for the same reason bootstrap.ts creates it: the worker
    // resolves it and refuses to mint one from inside a job.
    const extractor = await admin.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor') returning id",
      [orgId],
    );

    return {
      orgId,
      actorId: human.rows[0]?.id ?? "",
      extractorId: extractor.rows[0]?.id ?? "",
    };
  } finally {
    await admin.end();
  }
}

export type RunnerPorts = Parameters<typeof makeSectionExtractHandler>[0];

export type RunnerOptions = {
  readonly corpus: Corpus;
  readonly labels: readonly LabelSet[];
  readonly slice: RunFile["slice"];
  readonly split: RunFile["split"];
  readonly extractorVersion: string;
  readonly ports: RunnerPorts["ports"];
  readonly databaseUrl: string;
  readonly signal?: AbortSignal;
};

export type RunnerResult = {
  readonly adjudications: AdjudicatedAtomRecord[];
  readonly expectedAtomIds: string[];
  readonly coverage: { self: number; public: number; synthetic: number };
  readonly documents: string[];
  /**
   * The tenant this run created, so a second measurement — retrieval — can
   * ratify and query the same atoms instead of guessing where they went.
   */
  readonly tenant: { orgId: string; actorId: string; projectId: string };
};

function documentsFor(options: RunnerOptions): LoadedDocument[] {
  return options.corpus.documents.filter(
    (d) =>
      d.split === options.split &&
      (options.slice === "all" || d.tier === options.slice),
  );
}

/**
 * Runs the pipeline and returns what a human has to adjudicate.
 *
 * Sections are processed in the fixed order a rebuild uses — documents by id,
 * sections by ordinal — because deduplication is first-writer-wins and a
 * different order would produce a different, equally correct corpus that the
 * harness would read as noise.
 */
export async function runExtraction(
  options: RunnerOptions,
): Promise<RunnerResult> {
  const documents = documentsFor(options);
  if (documents.length === 0) {
    throw new RunnerError(
      `no corpus documents match slice ${options.slice} and split ${options.split}.`,
    );
  }

  // Every covered section must be labelled, or the run cannot be adjudicated
  // and its recall denominator would silently be wrong. Named rather than
  // counted, so the fix is obvious.
  const labelled = new Set(
    options.labels.flatMap((set) =>
      set.sections.map((s) => `${set.document}#${s.sectionHash}`),
    ),
  );
  const unlabelled: string[] = [];
  for (const document of documents) {
    for (const section of document.sections) {
      const key = `${document.id}#${section.sectionHash}`;
      if (!labelled.has(key)) {
        unlabelled.push(`${document.id} § ${section.headingPath.join(" > ")}`);
      }
    }
  }
  if (unlabelled.length > 0) {
    throw new RunnerError(
      `${unlabelled.length} section(s) in this slice are unlabelled, so no number from them could be adjudicated:\n  ${unlabelled.slice(0, 10).join("\n  ")}${unlabelled.length > 10 ? `\n  … and ${unlabelled.length - 10} more` : ""}`,
    );
  }

  const tenant = await seedTenant(options.databaseUrl);
  const handle = makeSectionExtractHandler({ ports: options.ports });
  const signal = options.signal ?? new AbortController().signal;

  const project = await withActor(tenant.orgId, tenant.actorId, (db) =>
    createProject(db, tenant.orgId, {
      name: "eval",
      slug: `eval-${Date.now()}-${process.pid}`,
    }),
  );

  // Enqueue nowhere. The queue is the right shape for a document push, where
  // order between sections is an ordinary race; a run that has to be
  // reproducible drives the handler directly and in order, for the same reason
  // rebuildProject does.
  const jobs: SectionExtractJob[] = [];
  const noEnqueue = {
    extractorVersion: options.extractorVersion,
    enqueue: async (_db: unknown, job: SectionExtractJob) => {
      jobs.push(job);
    },
  };

  for (const document of [...documents].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    await withActor(tenant.orgId, tenant.actorId, (db) =>
      putDocument(
        db,
        tenant.orgId,
        project.id,
        { path: document.file, title: document.title, body: document.text },
        noEnqueue,
      ),
    );
  }

  for (const job of jobs) {
    await handle(job, signal);
  }

  // Read the atoms back with the provenance a human needs to adjudicate them:
  // which section, and which of the expected atoms it might correspond to.
  const admin = new Client({ connectionString: options.databaseUrl });
  await admin.connect();
  let rows: Array<{
    statement: string;
    kind: string;
    source_quote: string;
    heading_path: string[];
    body: string;
    path: string;
  }>;
  try {
    const result = await admin.query(
      `select a.statement, a.kind, a.source_quote,
              s.heading_path, s.body, d.path
         from atoms a
         join document_sections s on s.id = a.section_id
         join documents d on d.id = a.document_id
        where a.project_id = $1
        order by d.path, s.ordinal, lower(a.source_span), a.statement`,
      [project.id],
    );
    rows = result.rows;
  } finally {
    await admin.end();
  }

  const adjudications: AdjudicatedAtomRecord[] = rows.map((row) => ({
    // Keyed by section hash, exactly as the labels are. A document field here
    // would be a second key that can disagree with the first.
    sectionHash: sectionHash(row.heading_path, row.body),
    statement: row.statement,
    kind: row.kind as AdjudicatedAtomRecord["kind"],
    quote: row.source_quote,
    // Null, and it stays null until a person fills it in. A runner that scored
    // its own output would be the system grading itself, which is the whole
    // thing docs/12-evaluation.md refuses.
    verdict: null,
  }));

  const covered = new Set(documents.map((d) => d.id));
  const expectedAtomIds = options.labels
    .filter((set) => covered.has(set.document))
    .flatMap((set) =>
      set.sections.flatMap((section) =>
        section.expect.map((_, index) => expectedAtomId(section, index)),
      ),
    );

  const coverage = { self: 0, public: 0, synthetic: 0 };
  for (const document of documents) {
    coverage[document.tier] += document.sections.length;
  }

  return {
    adjudications,
    expectedAtomIds,
    coverage,
    documents: documents.map((d) => d.id).sort(),
    tenant: {
      orgId: tenant.orgId,
      actorId: tenant.actorId,
      projectId: project.id,
    },
  };
}

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "@standfast/api";
import { closePool, generateApiKey } from "@standfast/db";
import { createServer } from "@standfast/mcp";
import { Client } from "pg";
import { z } from "zod";
import { RunnerError } from "./runner.js";

/**
 * How long `context` takes, measured where the user feels it.
 *
 * **This slice sets no bar and never fails on a number.** The p95 latency
 * contract for `context` is Open and owned by `docs/14-roadmap.md`, which says
 * why a harness must not choose it: "It cannot be measured first and declared
 * after: a contract set to whatever the implementation happened to achieve is
 * not a contract." So there is no threshold here, no entry in
 * `baselines.json`, and no exit code that depends on how fast the run was. The
 * only failures are operational ones — a database that will not answer, a
 * warm-up that would consume the whole sample.
 *
 * The measurement point is `docs/06-retrieval.md`'s, verbatim: "measured end to
 * end from the MCP tool call rather than from the SQL, because the tool call is
 * what the user experiences". So the harness drives a real MCP client over
 * `InMemoryTransport` against the real server, whose typed SDK client is handed
 * a fetch that dispatches straight into the real Hono app — the same seam
 * `packages/api/src/mcp.integration.test.ts` uses. Nothing on the path is
 * stubbed: MCP codec, Zod validation, auth middleware, `buildContext`,
 * `setRetrievalGucs`, the one fused SQL statement, MMR and budgeted assembly
 * all run.
 *
 * `docs/12-evaluation.md` prescribes nothing for latency — it owns the four
 * accuracy metrics and their corpus — so this follows the shape of the runners
 * it does prescribe: its own database under `STANDFAST_EVAL_DATABASE_URL`, a
 * loud skip when a precondition is unmet, and a run file in `eval/runs/`.
 */

/**
 * The corpus this measurement needs is **volume, not labels**.
 *
 * That is the whole reason this number is obtainable today while extraction
 * precision, retrieval precision and the reconciliation false-positive rate are
 * not: a percentile is a property of how much data the query planner walks,
 * and no human has to read an atom for that to be true. Nothing here is a
 * substitute for the labelled corpus, and no accuracy claim may be made from
 * a run of this slice.
 */
export type Scale = {
  /** Total canonical atoms — the number the fused SQL actually walks. */
  readonly atoms: number;
  readonly documents: number;
  readonly sectionsPerDocument: number;
  readonly atomsPerSection: number;
};

/**
 * 2000 atoms, stated rather than tuned: roughly a mid-sized codebase's worth of
 * ratified conventions, and enough that the HNSW index is used rather than
 * planned around. It is a default, not a finding — override it with
 * `STANDFAST_EVAL_LATENCY_ATOMS`, and read every number below against the
 * scale the report prints, because a latency figure without its corpus size
 * says nothing at all.
 */
export const DEFAULT_ATOMS = 2000;
/**
 * 200, of which 180 survive the warm-up — enough that the reported p95 is the
 * tenth-slowest observation rather than the slowest. At n = 20 the p95 *is* the
 * maximum, and a tail estimated from a single unlucky request is noise wearing
 * a percentile's name.
 */
export const DEFAULT_ITERATIONS = 200;
/** See `trimWarmup` for why these are taken and thrown away. */
export const DEFAULT_WARMUP = 20;

const SECTIONS_PER_DOCUMENT = 12;
const ATOMS_PER_SECTION = 4;

export function scaleFor(atoms: number): Scale {
  const perDocument = SECTIONS_PER_DOCUMENT * ATOMS_PER_SECTION;
  return {
    atoms,
    documents: Math.max(1, Math.ceil(atoms / perDocument)),
    sectionsPerDocument: SECTIONS_PER_DOCUMENT,
    atomsPerSection: ATOMS_PER_SECTION,
  };
}

const EMBEDDING_DIMENSIONS = 1024;
const QUOTE_LENGTH = 32;

/**
 * A random unit vector, one per atom.
 *
 * **These make timing realistic and ANN recall unrealistic, and only the first
 * of those is being measured here.** Random directions in 1024 dimensions are
 * near-orthogonal to each other and to any query, so the neighbour list HNSW
 * returns is meaningless as a ranking — but the graph it builds has the same
 * node and edge count as a real one, the traversal touches the same number of
 * pages, and the distance computations are identical work. No accuracy number
 * may ever be taken from a corpus seeded this way; that is what the labelled
 * corpus is for.
 */
function unitVector(random: () => number): string {
  const values = new Array<number>(EMBEDDING_DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    // Box–Muller, so the directions are uniform on the sphere rather than
    // clustered toward the corners of the cube that `random()` alone fills.
    const u = Math.max(random(), Number.EPSILON);
    const v = random();
    const value = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    values[i] = value;
    norm += value * value;
  }
  const length = Math.sqrt(norm) || 1;
  return `[${values.map((value) => (value / length).toFixed(6)).join(",")}]`;
}

/** Deterministic, so two runs at the same scale walk the same graph. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The whole `atom_kind` enum. A fourth value here would be rejected by it. */
const KINDS = ["decision", "convention", "constraint"] as const;

const VOCABULARY = [
  "migration",
  "queue",
  "tenancy",
  "embedding",
  "retrieval",
  "budget",
  "actor",
  "extraction",
  "reconciliation",
  "ratification",
  "provenance",
  "allowlist",
] as const;

function phrase(random: () => number, words: number): string {
  return Array.from(
    { length: words },
    () => VOCABULARY[Math.floor(random() * VOCABULARY.length)] as string,
  ).join(" ");
}

export type Tenant = {
  readonly orgId: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly apiKey: string;
};

/**
 * Writes the synthetic corpus straight through an admin connection.
 *
 * Not through the extraction pipeline: the pipeline is measured by
 * `pnpm eval extraction`, seeding two thousand atoms through it would take
 * minutes to produce content nobody reads, and the read path cannot tell how a
 * row arrived. Bulk `insert` is what a fixture at this scale should be.
 */
export async function seedCorpus(
  databaseUrl: string,
  scale: Scale,
): Promise<Tenant> {
  const random = mulberry32(20260826);
  const suffix = `${Date.now()}-${process.pid}`;
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    // Every run starts from an empty table, because otherwise the corpus grows
    // by one scale per run and the size this report prints stops being the size
    // the query planner walked — which is the one thing a latency figure cannot
    // be wrong about. Safe because `evalDatabaseUrl` has already refused any
    // URL something else serves from.
    await db.query("truncate orgs cascade");

    const org = await db.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $1) returning id",
      [`latency-${suffix}`],
    );
    const orgId = org.rows[0]?.id ?? "";

    const actor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'agent', 'latency') returning id",
      [orgId],
    );
    const actorId = actor.rows[0]?.id ?? "";
    // Canonical atoms carry a ratifier, and only a human ratifies (migration
    // 0013). The fixture honours that constraint rather than working around it.
    const human = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', 'latency-ratifier') returning id",
      [orgId],
    );
    const humanId = human.rows[0]?.id ?? "";
    // Production creates this with the org (migration 0004); anything that
    // creates an org creates one too, because putDocument resolves it and
    // refuses to mint one itself.
    await db.query(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor')",
      [orgId],
    );

    const project = await db.query<{ id: string }>(
      "insert into projects (org_id, name, slug) values ($1, $2, $2) returning id",
      [orgId, `latency-${suffix}`],
    );
    const projectId = project.rows[0]?.id ?? "";

    const generated = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
         values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [orgId, actorId, `${generated.prefix}-${suffix}`, generated.hash],
    );

    let remaining = scale.atoms;
    for (let d = 0; d < scale.documents && remaining > 0; d += 1) {
      const documentId = randomUUID();
      const path = `src/${VOCABULARY[d % VOCABULARY.length]}/module-${d}.ts`;
      await db.query(
        `insert into documents (id, org_id, project_id, path, title, body, content_hash)
           values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          documentId,
          orgId,
          projectId,
          path,
          `Module ${d}`,
          phrase(random, 40),
          `sha256:${randomUUID().replace(/-/g, "")}`,
        ],
      );

      for (let s = 0; s < scale.sectionsPerDocument && remaining > 0; s += 1) {
        const sectionId = randomUUID();
        const body = phrase(random, 30);
        await db.query(
          `insert into document_sections (id, org_id, document_id, ordinal, heading_path, body, section_hash)
             values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sectionId,
            orgId,
            documentId,
            s,
            [`Module ${d}`, `Section ${s}`],
            body,
            `sha256:${randomUUID().replace(/-/g, "")}`,
          ],
        );

        const rows: unknown[] = [];
        const placeholders: string[] = [];
        const take = Math.min(scale.atomsPerSection, remaining);
        for (let a = 0; a < take; a += 1) {
          // A trigger checks source_quote against source_span character for
          // character, so the quote is cut from the body rather than invented.
          const start = Math.max(
            0,
            Math.min(a * 8, body.length - QUOTE_LENGTH),
          );
          const end = Math.min(start + QUOTE_LENGTH, body.length);
          const base = rows.length;
          placeholders.push(
            `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},'canonical',$${base + 7},int4range(${start},${end}),$${base + 8}::vector,'latency-fixture',$${base + 9},'human',now())`,
          );
          rows.push(
            orgId,
            projectId,
            documentId,
            sectionId,
            `${phrase(random, 8)} must ${phrase(random, 4)}`,
            KINDS[Math.floor(random() * KINDS.length)],
            body.slice(start, end),
            unitVector(random),
            humanId,
          );
        }
        await db.query(
          `insert into atoms (org_id, project_id, document_id, section_id, statement, kind, status, source_quote, source_span, embedding, extractor_version, ratified_by, ratified_by_kind, ratified_at)
             values ${placeholders.join(",")}`,
          rows,
        );
        remaining -= take;
      }
    }

    // The planner picks a sequential scan over a table it has never counted, and
    // that is not the plan a served query gets. Analyzing is part of standing the
    // fixture up, not part of what is being timed.
    await db.query("analyze atoms");
    await db.query("analyze document_sections");

    return { orgId, actorId, projectId, apiKey: generated.key };
  } finally {
    await db.end();
  }
}

/** One `context` request, repeated. Varied so the plan cache is not the subject. */
export type Probe = {
  readonly scope: "task" | "file" | "project";
  readonly query?: string;
  readonly paths: string[];
  readonly budgetTokens: number;
};

export function probes(): Probe[] {
  const random = mulberry32(7);
  return Array.from({ length: 16 }, (_, i) => ({
    scope: "task" as const,
    query: `about to change the ${phrase(random, 5)}`,
    paths: [`src/${VOCABULARY[i % VOCABULARY.length]}/module-${i}.ts`],
    budgetTokens: 4000,
  }));
}

export type Series = {
  /** Milliseconds, in the order they were observed — warm-up first. */
  readonly samples: number[];
};

export type LatencyResult = {
  readonly scale: Scale;
  readonly iterations: number;
  readonly warmup: number;
  /** The full MCP chain: client → server → SDK → route → buildContext. */
  readonly tool: Series;
  /** The HTTP route alone. The delta against `tool` is the MCP layer's cost. */
  readonly route: Series;
  /**
   * Stages the read path reported as not run, unioned over every measured call.
   * `"dense"` here means no query embedder was bound and generator 1 never ran.
   */
  readonly skippedStages: string[];
  readonly packedAtoms: number;
  readonly totalCandidates: number;
};

export type LatencyOptions = {
  readonly databaseUrl: string;
  /** The same database, addressed as the unprivileged role the API connects as. */
  readonly appDatabaseUrl: string;
  readonly scale: Scale;
  readonly iterations: number;
  readonly warmup: number;
};

/** Grants the API's role what it needs in this database, as the API tests do. */
async function ensureAppRole(databaseUrl: string, role: string): Promise<void> {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query(`DO $$ BEGIN
      CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.query(`GRANT "standfast_app" TO ${role}`);
  } finally {
    await db.end();
  }
}

export async function runLatency(
  options: LatencyOptions,
): Promise<LatencyResult> {
  if (options.warmup >= options.iterations) {
    throw new RunnerError(
      `a warm-up of ${options.warmup} leaves nothing of ${options.iterations} iteration(s) to report. Raise STANDFAST_EVAL_LATENCY_ITERATIONS or lower STANDFAST_EVAL_LATENCY_WARMUP.`,
    );
  }

  const appUrl = new URL(options.appDatabaseUrl);
  await ensureAppRole(options.databaseUrl, appUrl.username);
  const tenant = await seedCorpus(options.databaseUrl, options.scale);

  // The pool reads DATABASE_URL and there is no other seam into it. Set after
  // `evalDatabaseUrl` has already refused the case that matters — an eval URL
  // equal to the one something else serves from — and pointed at the eval
  // database under the API's own unprivileged role, so RLS is enforced here
  // exactly as it is in production.
  const previous = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = options.appDatabaseUrl;

  const app = createApp();
  const server = createServer({
    baseUrl: "http://standfast.eval",
    apiKey: tenant.apiKey,
    fetch: ((input: Request) => app.request(input)) as typeof globalThis.fetch,
  });
  const client = new McpClient({ name: "eval-latency", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const plan = probes();
  const tool: number[] = [];
  const route: number[] = [];
  const skipped = new Set<string>();
  let packedAtoms = 0;
  let totalCandidates = 0;

  try {
    for (let i = 0; i < options.iterations; i += 1) {
      const probe = plan[i % plan.length] as Probe;

      const toolStart = performance.now();
      const result = (await client.callTool({
        name: "context",
        arguments: { projectId: tenant.projectId, ...probe },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      tool.push(performance.now() - toolStart);

      if (result.isError) {
        throw new RunnerError(
          `the context tool failed, so there is nothing to time: ${result.content?.[0]?.text ?? "no detail"}`,
        );
      }

      const routeStart = performance.now();
      const response = await app.request(
        `/v1/projects/${tenant.projectId}/context`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${tenant.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(probe),
        },
      );
      route.push(performance.now() - routeStart);

      if (!response.ok) {
        throw new RunnerError(
          `the context route answered ${response.status}, so there is nothing to time`,
        );
      }
      const pack = (await response.json()) as {
        items?: unknown[];
        total?: number;
        skipped?: string[];
      };
      for (const stage of pack.skipped ?? []) {
        skipped.add(stage);
      }
      packedAtoms = pack.items?.length ?? 0;
      totalCandidates = pack.total ?? 0;
    }
  } finally {
    await client.close();
    await closePool();
    if (previous === undefined) {
      delete process.env["DATABASE_URL"];
    } else {
      process.env["DATABASE_URL"] = previous;
    }
  }

  return {
    scale: options.scale,
    iterations: options.iterations,
    warmup: options.warmup,
    tool: { samples: tool },
    route: { samples: route },
    skippedStages: [...skipped].sort(),
    packedAtoms,
    totalCandidates,
  };
}

/**
 * What was actually bound on the read path, as evidence rather than assumption.
 *
 * The read path resolves its ports differently from the worker
 * (`packages/api/src/ports.ts`): with no `STANDFAST_EGRESS_ALLOWLIST` entry for
 * `query-embedding` there is **no query embedder at all** — not a fake one —
 * and generator 1 silently drops out, which is condition 5 of
 * `docs/06-retrieval.md` working as designed. The reranker is never bound.
 *
 * This matters more to a latency number than to any other: an unbound embedder
 * removes a provider round trip *and* the HNSW traversal from the measurement.
 * A figure from such a run is a **floor**, not a forecast, and the report says
 * so every time rather than only when someone remembers to ask.
 */
export function boundProviders(
  env: Record<string, string | undefined> = process.env,
): { queryEmbedding: string; reranker: string; real: boolean } {
  const allowlist = env["STANDFAST_EGRESS_ALLOWLIST"];
  return {
    queryEmbedding: allowlist
      ? `bound via STANDFAST_EGRESS_ALLOWLIST (${allowlist})`
      : "unbound — no STANDFAST_EGRESS_ALLOWLIST entry for query-embedding",
    reranker: "unbound — no provider has passed the acceptance test",
    real: Boolean(allowlist),
  };
}

const Distribution = z.object({
  n: z.number().int().positive(),
  min: z.number(),
  p50: z.number(),
  p90: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
});

/**
 * A committed latency run.
 *
 * It records no bar, no baseline and no verdict, because there is none to
 * record. `notAContract` is a field rather than a comment so the statement
 * travels with the number: anyone who reads this file out of context — pasted
 * into an issue, quoted in a review — reads the caveat with it.
 */
export const LatencyRunFile = z.object({
  version: z.literal(1),
  metric: z.literal("context_latency"),
  ranOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  codeRevision: z.string().min(1),
  scale: z.object({
    atoms: z.number().int().positive(),
    documents: z.number().int().positive(),
    sectionsPerDocument: z.number().int().positive(),
    atomsPerSection: z.number().int().positive(),
    /** Random unit vectors: realistic for timing, meaningless for recall. */
    embeddings: z.literal("random-unit-vectors"),
  }),
  sampling: z.object({
    iterations: z.number().int().positive(),
    warmup: z.number().int().nonnegative(),
    percentileDefinition: z.literal("nearest-rank"),
  }),
  providers: z.object({
    queryEmbedding: z.string().min(1),
    reranker: z.string().min(1),
    /** False whenever a stage was absent, which makes every figure a floor. */
    realProvidersBound: z.boolean(),
  }),
  skippedStages: z.array(z.string()),
  pack: z.object({
    itemsInLastPack: z.number().int().nonnegative(),
    candidatesInLastPack: z.number().int().nonnegative(),
  }),
  milliseconds: z.object({
    /** End to end from the MCP tool call — the figure docs/06 asks for. */
    tool: Distribution,
    /** The HTTP route alone; tool minus route is the MCP layer's own cost. */
    route: Distribution,
  }),
  notAContract: z.string().min(1),
});

export type LatencyRunFile = z.infer<typeof LatencyRunFile>;

/**
 * The sentence that must accompany every number this slice produces.
 *
 * `docs/14-roadmap.md` owns the p95 contract and has not chosen its value. A
 * measurement taken here is what the implementation happened to achieve, which
 * is precisely what the roadmap says a contract must not be set from.
 */
export const NOT_A_CONTRACT =
  "This is a measurement, not a contract. The p95 latency contract for `context` " +
  "is Open and owned by docs/14-roadmap.md, which states that it cannot be " +
  "measured first and declared after — a contract set to whatever the " +
  "implementation happened to achieve is not a contract. No number in this file " +
  "may be adopted as that value, and no bar is recorded in eval/baselines.json.";

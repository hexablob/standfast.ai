import { RRF_K, rrfFuse } from "@standfast/core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import {
  type GeneratorName,
  retrieveCandidates,
  setRetrievalGucs,
} from "../repositories/retrieval.js";
import {
  adminClient,
  adminUrl,
  ensureTestRole,
  QUOTE_A,
  type Seed,
  SPAN_A,
  seed,
} from "./harness.js";

/**
 * The four generators, the fusion over them, and the one place vector search
 * interacts badly with tenancy.
 *
 * These run against a real Postgres because there is nothing to unit-test here:
 * the fusion is a SQL statement, the indexes are the point, and a fake would be
 * asserting that a string was assembled rather than that a query returns the
 * right rows. `docs/06-retrieval.md` is the specification each test names.
 */

let data: Seed;
let atoms: Record<string, string>;
const originalUrl = process.env["DATABASE_URL"];
// Captured before the override in `beforeAll`. `adminClient` reads
// DATABASE_URL, and every test below runs with that variable pointing at the
// unprivileged role — so an admin client built later is not an admin at all,
// and its inserts are refused by the very policies the seed has to bypass.
let superuserUrl = "";

/** 1024, because migration 0002 fixed the column at 1024. */
function vector(direction: number[]): string {
  const full = Array.from({ length: 1024 }, (_, i) => direction[i] ?? 0);
  return `[${full.join(",")}]`;
}

const EAST = vector([1, 0]);
const NORTH = vector([0, 1]);
const NEAR_EAST = vector([0.9, Math.sqrt(1 - 0.81)]);

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const admin = await adminClient();
  try {
    // Canonical, and therefore ratified: migration 0000 makes a canonical atom
    // without a human ratifier unrepresentable, so a fixture cannot take the
    // shortcut the production path is forbidden.
    const atom = async (
      statement: string,
      kind: string,
      embedding: string | null,
    ): Promise<string> => {
      const r = await admin.query<{ id: string }>(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind, status,
            source_quote, source_span, ratified_by, ratified_by_kind, ratified_at, embedding)
         values ($1,$2,$3,$4,$5,$6,'canonical',$7,$8::int4range,$9,'human',now(),$10::vector)
         returning id`,
        [
          data.orgA,
          data.projectA,
          data.documentA,
          data.sectionA,
          statement,
          kind,
          QUOTE_A,
          SPAN_A,
          data.humanA,
          embedding,
        ],
      );
      return r.rows[0]?.id ?? "";
    };

    atoms = {
      // Named so each generator has something only it should find.
      pathy: await atom(
        "packages/core is pure domain: no I/O, testable without a database.",
        "constraint",
        EAST,
      ),
      lexical: await atom(
        "Every migration is reversible and tested against an ephemeral database.",
        "convention",
        NORTH,
      ),
      nearDuplicate: await atom(
        "packages/core holds pure domain logic and performs no I/O.",
        "constraint",
        NEAR_EAST,
      ),
      unembedded: await atom(
        "The generated OpenAPI artifact is committed.",
        "decision",
        null,
      ),
    };

    // Provisional, and therefore never a candidate. docs/06-retrieval.md
    // declines exposing provisional atoms through context even behind a flag.
    await admin.query(
      `insert into atoms
         (org_id, project_id, document_id, section_id, statement, kind, status,
          source_quote, source_span, embedding)
       values ($1,$2,$3,$4,'packages/core is a provisional statement nobody ratified.',
               'constraint','provisional',$5,$6::int4range,$7::vector)`,
      [
        data.orgA,
        data.projectA,
        data.documentA,
        data.sectionA,
        QUOTE_A,
        SPAN_A,
        EAST,
      ],
    );
  } finally {
    await admin.end();
  }

  superuserUrl = adminUrl();

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  if (originalUrl) {
    process.env["DATABASE_URL"] = originalUrl;
  }
});

const ALL: GeneratorName[] = ["dense", "lexical", "trigram", "structural"];

function request(overrides: Partial<Parameters<typeof retrieveCandidates>[1]>) {
  return {
    projectId: data.projectA,
    generators: ALL,
    queryEmbedding: null,
    lexicalQuery: null,
    trigramQuery: null,
    documentId: null,
    sectionId: null,
    perGeneratorLimit: 50,
    fusedLimit: 200,
    ...overrides,
  };
}

describe("the fused retrieval query", () => {
  it("runs all four generators in one statement and returns candidates", async () => {
    const found = await withActor(data.orgA, data.humanA, async (db) => {
      await setRetrievalGucs(db, { efSearch: 40, iterativeScan: true });
      return retrieveCandidates(
        db,
        request({
          queryEmbedding: Array.from({ length: 1024 }, (_, i) =>
            i === 0 ? 1 : 0,
          ),
          lexicalQuery: "pure domain database",
          trigramQuery: "packages/core",
        }),
      );
    });

    expect(found.candidates.length).toBeGreaterThan(0);
    // Every generator that had an input reported a count. A generator silently
    // returning nothing would leave the fused order looking healthy while one
    // quarter of the recall argument was missing.
    expect(Object.keys(found.counts).sort()).toEqual([...ALL].sort());
  });

  /**
   * The trigram generator exists for exactly this: a `tsvector` sees
   * `packages`, `core` and loses that they were one string.
   */
  it("finds an atom by a path fragment, which tokenisation would destroy", async () => {
    const found = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({ generators: ["trigram"], trigramQuery: "core is pure" }),
      ),
    );

    expect(found.candidates.map((c) => c.atomId)).toContain(atoms["pathy"]);
  });

  it("finds an atom by wording the query shares with it", async () => {
    const found = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({
          generators: ["lexical"],
          lexicalQuery: "migration reversible ephemeral",
        }),
      ),
    );

    expect(found.candidates.map((c) => c.atomId)).toContain(atoms["lexical"]);
  });

  it("ranks the nearest vector first", async () => {
    const found = await withActor(data.orgA, data.humanA, async (db) => {
      await setRetrievalGucs(db, { efSearch: 40, iterativeScan: true });
      return retrieveCandidates(
        db,
        request({
          generators: ["dense"],
          queryEmbedding: Array.from({ length: 1024 }, (_, i) =>
            i === 0 ? 1 : 0,
          ),
        }),
      );
    });

    expect(found.candidates[0]?.atomId).toBe(atoms["pathy"]);
    // The atom with no embedding cannot be a dense candidate, and its absence
    // here is why `packages/core/src/mmr.ts` gives it no diversity penalty
    // rather than dropping it: this generator never saw it.
    expect(found.candidates.map((c) => c.atomId)).not.toContain(
      atoms["unembedded"],
    );
  });

  /**
   * The fusion is a SQL statement and `packages/core/src/rrf.ts` is the oracle
   * it is checked against. Two implementations that can drift are a liability
   * unless a test pins them together — this is that test.
   */
  it("computes the same scores the reference implementation does", async () => {
    const lists: Record<string, string[]> = {};

    for (const generator of ["lexical", "trigram", "structural"] as const) {
      const single = await withActor(data.orgA, data.humanA, (db) =>
        retrieveCandidates(
          db,
          request({
            generators: [generator],
            lexicalQuery: "pure domain migration reversible",
            trigramQuery: "packages/core",
          }),
        ),
      );
      lists[generator] = single.candidates.map((c) => c.atomId);
    }

    const fused = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({
          generators: ["lexical", "trigram", "structural"],
          lexicalQuery: "pure domain migration reversible",
          trigramQuery: "packages/core",
        }),
      ),
    );

    const expected = rrfFuse(lists, RRF_K);

    expect(fused.candidates.map((c) => c.atomId)).toEqual(
      expected.map((e) => e.atomId),
    );
    for (const candidate of fused.candidates) {
      const oracle = expected.find((e) => e.atomId === candidate.atomId);
      expect(candidate.score).toBeCloseTo(oracle?.score ?? -1, 9);
    }
  });

  /**
   * `docs/06-retrieval.md` (*Truncation*): the flag is set by whichever stage
   * dropped something, and never recomputed at a boundary from `returned` and
   * `total`. Here `returned == total` and results were still dropped, which is
   * the case roadmap phase 2 exit criterion 2 asks for.
   */
  it("reports truncation from the stage that capped, not from the counts", async () => {
    const capped = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({ generators: ["structural"], perGeneratorLimit: 1 }),
      ),
    );

    expect(capped.candidates).toHaveLength(1);
    expect(capped.candidates.length).toBe(capped.counts.structural);
    expect(capped.truncated).toBe(true);
  });

  /**
   * And it stays informative. A flag that is always true is one the agent
   * learns to ignore, which costs us the one case where it mattered.
   */
  it("is not truncated when nothing was dropped", async () => {
    const found = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(db, request({ generators: ["structural"] })),
    );

    expect(found.truncated).toBe(false);
  });

  /**
   * The boundary the overfetched row exists for.
   *
   * Four canonical atoms and a cap of exactly four: everything fitted, and
   * nothing was dropped. Counting rows against the cap would report this as
   * truncated — a false positive on every project whose atom count happens to
   * equal a limit, and the reason `truncated` would stop meaning anything.
   */
  it("is not truncated when the result exactly fills the cap", async () => {
    const all = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(db, request({ generators: ["structural"] })),
    );

    const exact = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({
          generators: ["structural"],
          perGeneratorLimit: all.candidates.length,
        }),
      ),
    );

    expect(exact.candidates).toHaveLength(all.candidates.length);
    expect(exact.truncated).toBe(false);
  });

  it("is truncated at one below that, where a row genuinely was dropped", async () => {
    const all = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(db, request({ generators: ["structural"] })),
    );

    const short = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({
          generators: ["structural"],
          perGeneratorLimit: all.candidates.length - 1,
        }),
      ),
    );

    expect(short.candidates).toHaveLength(all.candidates.length - 1);
    expect(short.truncated).toBe(true);
  });

  it("never offers a provisional atom as a candidate", async () => {
    const found = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(
        db,
        request({
          generators: ["structural", "trigram"],
          trigramQuery: "provisional",
        }),
      ),
    );

    for (const candidate of found.candidates) {
      expect(candidate.statement).not.toContain("nobody ratified");
    }
  });

  it("carries provenance, which is what an instruction channel owes its reader", async () => {
    const found = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(db, request({ generators: ["structural"] })),
    );

    const first = found.candidates[0];
    expect(first?.provenance).toContain("docs/a.md#");
  });

  /**
   * Generator 4 answers `SessionStart` alone, from a btree and a sort, with
   * nothing to embed and nothing to rerank. Its prior puts constraints first.
   */
  it("answers with no query at all, constraints first", async () => {
    const found = await withActor(data.orgA, data.humanA, (db) =>
      retrieveCandidates(db, request({ generators: ["structural"] })),
    );

    expect(found.candidates.length).toBeGreaterThan(0);
    expect(found.candidates[0]?.kind).toBe("constraint");
  });

  /**
   * The tenancy interaction `docs/06-retrieval.md` insists phase 2 measures on
   * a deliberately lopsided fixture rather than assuming away.
   *
   * An HNSW scan visits a bounded number of neighbours and the policy filters
   * afterwards, so a tenant holding a small share of a large table can have
   * every returned row removed and be told there is nothing — with matching
   * rows sitting in the table. This seeds org B with far more vectors than
   * org A holds, all closer to the query, and asserts org A still sees its own.
   */
  it("still finds a tenant's own vectors when another org dominates the index", async () => {
    const admin = new Client({ connectionString: superuserUrl });
    await admin.connect();
    try {
      const projectB = await admin.query<{ id: string }>(
        "select id from projects where org_id = $1 limit 1",
        [data.orgB],
      );
      const documentB = await admin.query<{ id: string }>(
        "select id from documents where org_id = $1 limit 1",
        [data.orgB],
      );
      const sectionB = await admin.query<{ id: string }>(
        `insert into document_sections (org_id, document_id, ordinal, heading_path, body, section_hash)
         values ($1, $2, 0, ARRAY['B'], 'Quoted verbatim.', 'sec-b') returning id`,
        [data.orgB, documentB.rows[0]?.id],
      );
      const humanB = await admin.query<{ id: string }>(
        "insert into actors (org_id, kind, display_name) values ($1,'human','b') returning id",
        [data.orgB],
      );

      // Lopsided on purpose: many rows, all nearer the query than org A's.
      for (let i = 0; i < 400; i++) {
        await admin.query(
          `insert into atoms
             (org_id, project_id, document_id, section_id, statement, kind, status,
              source_quote, source_span, ratified_by, ratified_by_kind, ratified_at, embedding)
           values ($1,$2,$3,$4,$5,'decision','canonical','Quoted verbatim.','[0,16)'::int4range,
                   $6,'human',now(),$7::vector)`,
          [
            data.orgB,
            projectB.rows[0]?.id,
            documentB.rows[0]?.id,
            sectionB.rows[0]?.id,
            `org B filler ${i}`,
            humanB.rows[0]?.id,
            vector([1, 0.0001 * (i + 1)]),
          ],
        );
      }
    } finally {
      await admin.end();
    }

    const found = await withActor(data.orgA, data.humanA, async (db) => {
      await setRetrievalGucs(db, { efSearch: 40, iterativeScan: true });
      return retrieveCandidates(
        db,
        request({
          generators: ["dense"],
          queryEmbedding: Array.from({ length: 1024 }, (_, i) =>
            i === 0 ? 1 : 0,
          ),
        }),
      );
    });

    // The failure this guards against returns zero rows and looks like health.
    expect(found.candidates.length).toBeGreaterThan(0);
    expect(found.candidates.map((c) => c.atomId)).toContain(atoms["pathy"]);
    for (const candidate of found.candidates) {
      expect(candidate.statement).not.toContain("org B filler");
    }
  });
});

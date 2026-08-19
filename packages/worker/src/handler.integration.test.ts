import type { EgressEntry } from "@standfast/core";
import {
  createProject,
  currentExtractorVersion,
  putDocument,
  type SectionExtractJob,
  withActor,
} from "@standfast/db";
import {
  adminClient,
  adminUrl,
  ensureTestRole,
  installQueue,
  type Seed,
  seed,
} from "@standfast/db/testing";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AbsentQuoteExtractor,
  BagOfWordsEmbedder,
  BulletExtractor,
  fakePorts,
  ScriptedJudge,
} from "./fakes.js";
import { makeSectionExtractHandler } from "./handler.js";
import type { Verdict } from "./ports.js";

const EV = currentExtractorVersion();
const NEVER_ABORTED = new AbortController().signal;

const DOC = [
  "# Conventions",
  "",
  "- Deploys happen on Fridays",
  "- Tabs indent Makefiles",
  "",
].join("\n");

let data: Seed;
let admin: Client;
let originalUrl: string | undefined;
const recorded: SectionExtractJob[] = [];

const extraction = {
  extractorVersion: EV,
  enqueue: async (_db: unknown, job: SectionExtractJob) => {
    recorded.push(job);
  },
};

beforeAll(async () => {
  await ensureTestRole();
  await installQueue(adminUrl());
  data = await seed();
  admin = await adminClient();

  originalUrl = process.env["DATABASE_URL"];
  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
}, 60_000);

afterAll(async () => {
  await admin?.end();
  if (originalUrl) process.env["DATABASE_URL"] = originalUrl;
});

/**
 * A fresh project per test.
 *
 * Deduplication is project-scoped — docs/05-extraction.md: the same sentence in
 * two projects is two decisions that happen to agree — so tests sharing one
 * project would find every earlier test's atoms as incumbents, and each would
 * pass or fail depending on what ran before it.
 */
let projectId: string;

beforeEach(async () => {
  recorded.length = 0;
  const project = await withActor(data.orgA, data.humanA, (db) =>
    createProject(db, data.orgA, {
      name: `handler-${counter}`,
      slug: `handler-${counter++}`,
    }),
  );
  projectId = project.id;
});

let counter = 0;

/** Pushes a document and returns the jobs its new sections produced. */
async function push(path: string, body: string): Promise<SectionExtractJob[]> {
  const before = recorded.length;
  await withActor(data.orgA, data.humanA, (db) =>
    putDocument(db, data.orgA, projectId, { path, body }, extraction),
  );
  return recorded.slice(before);
}

async function atomsIn(sectionId: string) {
  const r = await admin.query<{
    statement: string;
    source_quote: string;
    embedding: string | null;
    extractor_version: string | null;
    status: string;
  }>(
    `select statement, source_quote, embedding, extractor_version, status
       from atoms where section_id = $1 order by statement`,
    [sectionId],
  );
  return r.rows;
}

async function extractionRow(sectionId: string) {
  const r = await admin.query<{
    status: string;
    attempts: number;
    error: string | null;
    candidates_total: number | null;
    candidates_dropped: number | null;
    candidates_truncated: boolean;
    lease_expires_at: Date | null;
  }>(
    `select status, attempts, error, candidates_total, candidates_dropped,
            candidates_truncated, lease_expires_at
       from section_extractions where section_id = $1 and extractor_version = $2`,
    [sectionId, EV],
  );
  return r.rows[0];
}

describe("the section.extract handler", () => {
  it("writes a provisional atom per surviving candidate, with its embedding", async () => {
    const [job] = await push("docs/basic.md", DOC);
    const handle = makeSectionExtractHandler({ ports: fakePorts() });

    const outcome = await handle(job as SectionExtractJob, NEVER_ABORTED);
    expect(outcome.status).toBe("extracted");
    expect(outcome.written).toBe(2);
    expect(outcome.candidatesDropped).toBe(0);

    const atoms = await atomsIn((job as SectionExtractJob).sectionId);
    expect(atoms).toHaveLength(2);
    for (const atom of atoms) {
      // Born provisional, like everything else this system writes, and stamped
      // with the version that produced it.
      expect(atom.status).toBe("provisional");
      expect(atom.extractor_version).toBe(EV);
      expect(atom.embedding).not.toBeNull();
    }

    const row = await extractionRow((job as SectionExtractJob).sectionId);
    expect(row?.status).toBe("succeeded");
    expect(row?.candidates_total).toBe(2);
    expect(row?.lease_expires_at).toBeNull();
  });

  it("writes a proposed event attributed to the extractor", async () => {
    const [job] = await push("docs/events.md", DOC);
    await makeSectionExtractHandler({ ports: fakePorts() })(
      job as SectionExtractJob,
      NEVER_ABORTED,
    );

    const events = await admin.query<{ event: string; actor_id: string }>(
      `select e.event, e.actor_id from atom_events e
         join atoms a on a.id = e.atom_id
        where a.section_id = $1`,
      [(job as SectionExtractJob).sectionId],
    );
    expect(events.rows).toHaveLength(2);
    for (const event of events.rows) {
      expect(event.event).toBe("proposed");
      expect(event.actor_id).toBe(data.extractorA);
    }
  });

  it("drops a candidate whose quote is not in the section, and counts it", async () => {
    const [job] = await push("docs/dropped.md", DOC);
    const handle = makeSectionExtractHandler({
      ports: fakePorts({ extractor: new AbsentQuoteExtractor() }),
    });

    const outcome = await handle(job as SectionExtractJob, NEVER_ABORTED);

    // Dropped and counted, never repaired and never fuzzy-matched. There is no
    // repair step, and the count is the raw material for the unsupported gate.
    expect(outcome.candidatesTotal).toBe(3);
    expect(outcome.candidatesDropped).toBe(1);
    expect(outcome.written).toBe(2);

    const row = await extractionRow((job as SectionExtractJob).sectionId);
    expect(row?.candidates_dropped).toBe(1);

    // And it is not a suppression: atom_suppressions is what dedup threw away.
    const suppressions = await admin.query(
      "select id from atom_suppressions where section_id = $1",
      [(job as SectionExtractJob).sectionId],
    );
    expect(suppressions.rowCount).toBe(0);
  });

  it("is a no-op on a second run at the same version", async () => {
    const [job] = await push("docs/idempotent.md", DOC);
    const handle = makeSectionExtractHandler({ ports: fakePorts() });

    await handle(job as SectionExtractJob, NEVER_ABORTED);
    const second = await handle(job as SectionExtractJob, NEVER_ABORTED);

    // A redelivered job, or a second worker racing the first, is free. This is
    // the idempotency guarantee, and it lives in the unique key rather than in
    // anything the worker remembers.
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already-succeeded");
    expect(await atomsIn((job as SectionExtractJob).sectionId)).toHaveLength(2);
  });

  it("skips a section that was deleted between enqueue and run", async () => {
    const [job] = await push("docs/vanished.md", DOC);
    await admin.query(
      "delete from documents where project_id = $1 and path = $2",
      [projectId, "docs/vanished.md"],
    );

    const outcome = await makeSectionExtractHandler({ ports: fakePorts() })(
      job as SectionExtractJob,
      NEVER_ABORTED,
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("section is gone");
  });

  it("leaves a live peer's claim alone", async () => {
    const [job] = await push("docs/held.md", DOC);
    const handle = makeSectionExtractHandler({ ports: fakePorts() });

    // Simulate a peer that claimed and is still working: a running row with a
    // lease in the future.
    await admin.query(
      `insert into section_extractions
         (org_id, project_id, section_id, extractor_version, section_hash,
          status, attempts, lease_expires_at)
       select s.org_id, d.project_id, s.id, $2, s.section_hash, 'running', 1,
              now() + interval '15 minutes'
         from document_sections s join documents d on d.id = s.document_id
        where s.id = $1`,
      [(job as SectionExtractJob).sectionId, EV],
    );

    const outcome = await handle(job as SectionExtractJob, NEVER_ABORTED);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("held");
    expect(await atomsIn((job as SectionExtractJob).sectionId)).toHaveLength(0);
  });

  it("takes over a crashed worker's claim once its lease expires", async () => {
    const [job] = await push("docs/crashed.md", DOC);
    const handle = makeSectionExtractHandler({ ports: fakePorts() });

    // Backdated in SQL rather than by injecting a clock: the lease is a
    // database fact, and the takeover is a conditional UPDATE against it.
    await admin.query(
      `insert into section_extractions
         (org_id, project_id, section_id, extractor_version, section_hash,
          status, attempts, started_at, lease_expires_at)
       select s.org_id, d.project_id, s.id, $2, s.section_hash, 'running', 1,
              now() - interval '1 hour', now() - interval '45 minutes'
         from document_sections s join documents d on d.id = s.document_id
        where s.id = $1`,
      [(job as SectionExtractJob).sectionId, EV],
    );

    const outcome = await handle(job as SectionExtractJob, NEVER_ABORTED);
    expect(outcome.status).toBe("extracted");

    const row = await extractionRow((job as SectionExtractJob).sectionId);
    expect(row?.status).toBe("succeeded");
    expect(row?.attempts).toBe(2);
  });

  it("records a failure with its stage, and no document prose", async () => {
    const [job] = await push("docs/failing.md", DOC);
    const handle = makeSectionExtractHandler({
      ports: fakePorts({
        extractor: new BulletExtractor({
          failOnCall: 1,
          error: new Error("upstream said 503"),
        }),
      }),
    });

    await expect(
      handle(job as SectionExtractJob, NEVER_ABORTED),
    ).rejects.toThrow(/extract: upstream said 503/);

    const row = await extractionRow((job as SectionExtractJob).sectionId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("extract: upstream said 503");
    // The error column is on the wire allowlist and the status tool will
    // surface it. It must not be able to carry the section body.
    expect(row?.error).not.toContain("Deploys happen on Fridays");
  });

  it("retries a failed extraction at the same version", async () => {
    const [job] = await push("docs/retry.md", DOC);

    await expect(
      makeSectionExtractHandler({
        ports: fakePorts({ extractor: new BulletExtractor({ failOnCall: 1 }) }),
      })(job as SectionExtractJob, NEVER_ABORTED),
    ).rejects.toThrow();

    // A transient provider outage must not need an operator with a SQL prompt.
    const outcome = await makeSectionExtractHandler({ ports: fakePorts() })(
      job as SectionExtractJob,
      NEVER_ABORTED,
    );
    expect(outcome.status).toBe("extracted");

    const row = await extractionRow((job as SectionExtractJob).sectionId);
    expect(row?.status).toBe("succeeded");
    expect(row?.attempts).toBe(2);
    expect(row?.error).toBeNull();
  });

  it("refuses a payload naming a project that does not own the section", async () => {
    const [job] = await push("docs/mismatch.md", DOC);
    const handle = makeSectionExtractHandler({ ports: fakePorts() });

    await expect(
      handle(
        {
          ...(job as SectionExtractJob),
          projectId: "00000000-0000-0000-0000-000000000000",
        },
        NEVER_ABORTED,
      ),
    ).rejects.toThrow(/does not own section/);
  });

  it("caps how many candidates one section may yield, and says that it did", async () => {
    const many = [
      "# Many",
      "",
      // Deliberately unrelated to each other. Near-identical bullets would put
      // the batch's own candidates in the judge band, and this test is about the
      // cap rather than about dedup.
      "- Deploys happen on Fridays",
      "- Tabs indent Makefiles",
      "- Reviews need two approvals",
      "- Secrets live in the vault",
      "- Migrations must be reversible",
      "- Logs redact email addresses",
      "- Builds pin their toolchain",
      "- Backups restore weekly",
      "",
    ].join("\n");
    const [job] = await push("docs/capped.md", many);

    const outcome = await makeSectionExtractHandler({
      ports: fakePorts(),
      candidateCap: 3,
    })(job as SectionExtractJob, NEVER_ABORTED);

    // Set, never inferred. A cap that applies silently reads as a section that
    // had nothing more to say.
    expect(outcome.candidatesTruncated).toBe(true);
    const row = await extractionRow((job as SectionExtractJob).sectionId);
    expect(row?.candidates_truncated).toBe(true);
  });

  it("refuses an embedding of the wrong width before it reaches the column", async () => {
    const [job] = await push("docs/wrongdim.md", DOC);

    class NarrowEmbedder extends BagOfWordsEmbedder {
      override async embed(texts: readonly string[], signal: AbortSignal) {
        const real = await super.embed(texts, signal);
        return real.map((v) => v.slice(0, 512));
      }
    }

    await expect(
      makeSectionExtractHandler({
        ports: fakePorts({ embedder: new NarrowEmbedder() }),
      })(job as SectionExtractJob, NEVER_ABORTED),
    ).rejects.toThrow(/embed: expected 1024 dimensions, got 512/);
  });
});

describe("deduplication", () => {
  it("suppresses a duplicate above the merge threshold and leaves the incumbent", async () => {
    const [first] = await push("docs/dedup-a.md", DOC);
    await makeSectionExtractHandler({ ports: fakePorts() })(
      first as SectionExtractJob,
      NEVER_ABORTED,
    );

    const incumbents = await atomsIn((first as SectionExtractJob).sectionId);

    // Same sentences, different document. Identical statements embed
    // identically, so both land above 0.93 and no model is asked.
    const [second] = await push("docs/dedup-b.md", DOC);
    const outcome = await makeSectionExtractHandler({ ports: fakePorts() })(
      second as SectionExtractJob,
      NEVER_ABORTED,
    );

    expect(outcome.written).toBe(0);
    expect(outcome.suppressed).toBe(2);

    const suppressions = await admin.query<{
      reason: string;
      similarity: number;
      duplicate_of_atom_id: string | null;
    }>(
      `select reason, similarity, duplicate_of_atom_id from atom_suppressions
        where section_id = $1`,
      [(second as SectionExtractJob).sectionId],
    );
    expect(suppressions.rowCount).toBe(2);
    for (const row of suppressions.rows) {
      expect(row.reason).toBe("duplicate:threshold");
      expect(Number(row.similarity)).toBeGreaterThan(0.93);
      expect(row.duplicate_of_atom_id).not.toBeNull();
    }

    // The incumbent is not touched. "Merge" means the candidate is not written.
    expect(await atomsIn((first as SectionExtractJob).sectionId)).toEqual(
      incumbents,
    );
  });

  it("never asks the judge about a pair outside the intermediate band", async () => {
    const [job] = await push("docs/no-judge.md", DOC);
    // ScriptedJudge with an empty script throws on any call at all. Two
    // disjoint bullets are far below 0.80, so nothing should reach it.
    const judge = new ScriptedJudge();

    const outcome = await makeSectionExtractHandler({
      ports: fakePorts({ judge }),
    })(job as SectionExtractJob, NEVER_ABORTED);

    expect(outcome.written).toBe(2);
    expect(judge.calls).toEqual([]);
  });

  it("asks the judge in the band, and writes when it says different-claim", async () => {
    const base =
      "# Band\n\n- Deploys happen on Fridays and never on weekends\n\n";
    const near =
      "# Band\n\n- Deploys happen on Fridays and never on Mondays or holidays\n\n";

    const [first] = await push("docs/band-a.md", base);
    await makeSectionExtractHandler({ ports: fakePorts() })(
      first as SectionExtractJob,
      NEVER_ABORTED,
    );

    const script = new Map<string, Verdict>([
      [
        ScriptedJudge.key(
          "Deploys happen on Fridays and never on Mondays or holidays.",
          "Deploys happen on Fridays and never on weekends.",
        ),
        "different-claim",
      ],
    ]);
    const judge = new ScriptedJudge(script);

    const [second] = await push("docs/band-b.md", near);
    const outcome = await makeSectionExtractHandler({
      ports: fakePorts({ judge }),
    })(second as SectionExtractJob, NEVER_ABORTED);

    expect(judge.calls).toHaveLength(1);
    expect(outcome.written).toBe(1);
    expect(outcome.suppressed).toBe(0);
  });

  it("suppresses when the judge says same-claim", async () => {
    const base =
      "# Band2\n\n- Every change requires two approvals from other reviewers before merging\n\n";
    const near =
      "# Band2\n\n- Every change requires two approvals from other reviewers before landing\n\n";

    const [first] = await push("docs/band2-a.md", base);
    await makeSectionExtractHandler({ ports: fakePorts() })(
      first as SectionExtractJob,
      NEVER_ABORTED,
    );

    const script = new Map<string, Verdict>([
      [
        ScriptedJudge.key(
          "Every change requires two approvals from other reviewers before landing.",
          "Every change requires two approvals from other reviewers before merging.",
        ),
        "same-claim",
      ],
    ]);
    const judge = new ScriptedJudge(script);

    const [second] = await push("docs/band2-b.md", near);
    const outcome = await makeSectionExtractHandler({
      ports: fakePorts({ judge }),
    })(second as SectionExtractJob, NEVER_ABORTED);

    expect(outcome.written).toBe(0);
    expect(outcome.suppressed).toBe(1);

    const rows = await admin.query<{ reason: string }>(
      "select reason from atom_suppressions where section_id = $1",
      [(second as SectionExtractJob).sectionId],
    );
    expect(rows.rows[0]?.reason).toBe("duplicate:judge");
  });

  it("deduplicates within one section without touching the database", async () => {
    const twice =
      "# Twice\n\n- Deploys happen on Fridays\n- Deploys happen on Fridays\n\n";
    const [job] = await push("docs/intra.md", twice);

    const outcome = await makeSectionExtractHandler({ ports: fakePorts() })(
      job as SectionExtractJob,
      NEVER_ABORTED,
    );

    expect(outcome.written).toBe(1);
    expect(outcome.suppressed).toBe(1);

    const rows = await admin.query<{
      reason: string;
      duplicate_of_atom_id: string | null;
    }>(
      "select reason, duplicate_of_atom_id from atom_suppressions where section_id = $1",
      [(job as SectionExtractJob).sectionId],
    );
    expect(rows.rows[0]?.reason).toBe("duplicate:batch");
    // No incumbent to point at: the winner was written in this same batch.
    expect(rows.rows[0]?.duplicate_of_atom_id).toBeNull();
  });
});

/**
 * Fakes that claim to send something.
 *
 * A deterministic fake opens no socket and says so with `egress: null`, which
 * is exactly why the disclosure path would otherwise be untested until the
 * first real provider run. These subclasses keep the fake behaviour and lie
 * about one field, so what is under test is the handler's accounting rather
 * than a provider's.
 */
const ORIGIN = "https://provider.test";

class DisclosingExtractor extends BulletExtractor {
  override readonly egress: EgressEntry = {
    purpose: "extraction",
    origin: ORIGIN,
    model: "test-extractor-2026-01-01",
  };
}

class DisclosingEmbedder extends BagOfWordsEmbedder {
  override readonly egress: EgressEntry = {
    purpose: "embedding",
    origin: ORIGIN,
    model: "test-embedder-2026-01-01",
  };
}

/**
 * Claims a purpose the column cannot hold, so the insert fails.
 *
 * The failure is the fixture. What it proves is the ordering: the record is
 * written before the request, so a record that cannot be written is a request
 * that is not made. Sending what cannot be accounted for is the one arrangement
 * docs/13-threat-model.md (*Egress*, rule 3) rules out.
 */
class UnwritableExtractor extends BulletExtractor {
  override readonly egress = {
    purpose: "not-a-purpose",
    origin: ORIGIN,
    model: "test-extractor-2026-01-01",
  } as unknown as EgressEntry;
}

async function egressRowsIn(projectId: string) {
  const r = await admin.query<{
    purpose: string;
    destination: string;
    model: string;
    input_items: number;
    input_chars: number;
    section_id: string | null;
  }>(
    `select purpose, destination, model, input_items, input_chars, section_id
       from egress_events where project_id = $1 order by at, purpose`,
    [projectId],
  );
  return r.rows;
}

describe("the disclosure record", () => {
  it("stays empty for a run on the deterministic fakes", async () => {
    const [job] = await push("docs/quiet.md", DOC);
    const handle = makeSectionExtractHandler({ ports: fakePorts() });
    await handle(job as SectionExtractJob, NEVER_ABORTED);

    // Nothing left the machine, so nothing claims to have. The absence is the
    // assertion: a pipeline that logged an outbound call it never made would
    // make the record useless in the other direction.
    expect(await egressRowsIn((job as SectionExtractJob).projectId)).toEqual(
      [],
    );
  });

  it("records one call per port that opens a socket", async () => {
    const [job] = await push("docs/loud.md", DOC);
    const handle = makeSectionExtractHandler({
      ports: fakePorts({
        extractor: new DisclosingExtractor(),
        embedder: new DisclosingEmbedder(),
      }),
    });
    const outcome = await handle(job as SectionExtractJob, NEVER_ABORTED);
    expect(outcome.status).toBe("extracted");

    const rows = await egressRowsIn((job as SectionExtractJob).projectId);
    expect(rows.map((r) => r.purpose)).toEqual(["extraction", "embedding"]);

    // The extractor was sent the section, once. The embedder was sent the two
    // surviving statements, in one batched call.
    const [extraction, embedding] = rows;
    expect(extraction?.destination).toBe(ORIGIN);
    expect(extraction?.model).toBe("test-extractor-2026-01-01");
    expect(extraction?.input_items).toBe(1);
    // The section's body, not the document's. Extraction is per section, and a
    // record that measured the whole document would overstate what left by
    // however much of it never reached this call.
    const body = await admin.query<{ body: string }>(
      "select body from document_sections where id = $1",
      [(job as SectionExtractJob).sectionId],
    );
    expect(extraction?.input_chars).toBe(body.rows[0]?.body.length);
    expect(embedding?.input_items).toBe(2);
    expect(embedding?.input_chars).toBeGreaterThan(0);

    // Both name the section whose prose left, so the record can be read back
    // against the document rather than only in aggregate.
    expect(extraction?.section_id).toBe((job as SectionExtractJob).sectionId);
  });

  it("does not call the port when the record cannot be written", async () => {
    const [job] = await push("docs/refused.md", DOC);
    const extractor = new UnwritableExtractor();
    const handle = makeSectionExtractHandler({
      ports: fakePorts({ extractor }),
    });

    await expect(
      handle(job as SectionExtractJob, NEVER_ABORTED),
    ).rejects.toThrow(/^disclose: /);
    expect(extractor.callCount).toBe(0);
  });
});

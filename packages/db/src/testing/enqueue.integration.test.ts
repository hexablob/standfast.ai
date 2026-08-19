import { currentExtractorVersion } from "@standfast/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withActor } from "../client.js";
import {
  enqueueSectionExtract,
  QUEUE_SCHEMA,
  SECTION_EXTRACT_QUEUE,
  stopBoss,
} from "../queue.js";
import { installQueue } from "../queue-install.js";
import { putDocument } from "../repositories/documents.js";
import {
  adminClient,
  adminUrl,
  ensureTestRole,
  type Seed,
  seed,
} from "./harness.js";

/**
 * The half of the enqueue that pg-boss owns.
 *
 * `extraction-invariants.integration.test.ts` proves what `putDocument` decides
 * to enqueue, using a recorder. This file proves the decision reaches the queue
 * — and, more importantly, that it does not when the transaction does not.
 */

const BODY = "# Alpha\nShip on Fridays.\n\n# Beta\nNever revert main.\n\n";

const extraction = {
  enqueue: enqueueSectionExtract,
  extractorVersion: currentExtractorVersion(),
};

let data: Seed;
let admin: Client;
let originalUrl: string | undefined;

beforeAll(async () => {
  await ensureTestRole();
  await installQueue(adminUrl());
  data = await seed();
  admin = await adminClient();

  // As the unprivileged role, like every other integration test here. Run as
  // the superuser these would pass while proving nothing about the grants.
  originalUrl = process.env["DATABASE_URL"];
  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
}, 60_000);

afterAll(async () => {
  await stopBoss();
  await admin?.end();
  if (originalUrl) process.env["DATABASE_URL"] = originalUrl;
});

async function jobCount(): Promise<number> {
  const r = await admin.query<{ n: string }>(
    `select count(*)::text n from "${QUEUE_SCHEMA}"."job" where name = $1`,
    [SECTION_EXTRACT_QUEUE],
  );
  return Number(r.rows[0]?.n ?? "0");
}

beforeEach(async () => {
  await admin.query(`delete from "${QUEUE_SCHEMA}"."job" where name = $1`, [
    SECTION_EXTRACT_QUEUE,
  ]);
});

describe("transactional enqueue", () => {
  it("puts a job on the queue for each new section", async () => {
    const result = await withActor(data.orgA, data.humanA, (db) =>
      putDocument(
        db,
        data.orgA,
        data.projectA,
        { path: "docs/queued.md", body: BODY },
        extraction,
      ),
    );

    expect(result.enqueued).toHaveLength(2);
    expect(await jobCount()).toBe(2);

    const rows = await admin.query<{ data: Record<string, string> }>(
      `select data from "${QUEUE_SCHEMA}"."job" where name = $1`,
      [SECTION_EXTRACT_QUEUE],
    );
    for (const row of rows.rows) {
      expect(row.data["orgId"]).toBe(data.orgA);
      expect(row.data["projectId"]).toBe(data.projectA);
      expect(row.data["actorId"]).toBe(data.extractorA);
      expect(row.data["extractorVersion"]).toBe(extraction.extractorVersion);
      expect(result.enqueued).toContain(row.data["sectionId"]);
    }
  });

  it("leaves no job behind when the transaction rolls back", async () => {
    // The one that earns its place. If somebody swaps fromDrizzle(db, sql) for
    // the pool, every other test in this repository still passes and only this
    // one fails — which is the whole reason "transactional enqueue is
    // mandatory" is a test rather than a comment. A job that survives a
    // rolled-back write is a job that extracts from a document that does not
    // exist.
    await expect(
      withActor(data.orgA, data.humanA, async (db) => {
        await putDocument(
          db,
          data.orgA,
          data.projectA,
          { path: "docs/rolled-back.md", body: BODY },
          extraction,
        );
        throw new Error("rolled back on purpose");
      }),
    ).rejects.toThrow("rolled back on purpose");

    expect(await jobCount()).toBe(0);

    // And the document went with it, which is the other half of the same fact.
    const doc = await admin.query(
      "select id from documents where project_id = $1 and path = $2",
      [data.projectA, "docs/rolled-back.md"],
    );
    expect(doc.rowCount).toBe(0);
  });

  it("enqueues nothing on a byte-identical re-push", async () => {
    await withActor(data.orgA, data.humanA, (db) =>
      putDocument(
        db,
        data.orgA,
        data.projectA,
        { path: "docs/twice.md", body: BODY },
        extraction,
      ),
    );
    expect(await jobCount()).toBe(2);

    await admin.query(`delete from "${QUEUE_SCHEMA}"."job" where name = $1`, [
      SECTION_EXTRACT_QUEUE,
    ]);

    await withActor(data.orgA, data.humanA, (db) =>
      putDocument(
        db,
        data.orgA,
        data.projectA,
        { path: "docs/twice.md", body: BODY },
        extraction,
      ),
    );
    expect(await jobCount()).toBe(0);
  });
});

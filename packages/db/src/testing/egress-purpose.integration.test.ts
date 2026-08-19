import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import { pageOf } from "../pagination.js";
import { listEgress, recordEgress } from "../repositories/egress.js";
import { adminUrl, ensureTestRole, type Seed, seed } from "./harness.js";

/**
 * That migration 0008 actually ran.
 *
 * Every other test of the read path's model call is about refusing to make it,
 * and passes whether or not the database can record one. This is the test that
 * fails if the migration was written and never applied — which has happened in
 * this repository once already, when 0007 was correct, inert, and unregistered
 * in the journal.
 *
 * It also pins the thing the purpose exists for. `docs/13-threat-model.md`
 * (*Egress*, rule 3) makes the record the answer to "what left, and to whom",
 * and a customer's real question is narrower than that: *do my questions leave,
 * or only my documents?* An `egress_events` table that spelled both `embedding`
 * cannot answer it.
 */

let data: Seed;
const originalUrl = process.env["DATABASE_URL"];

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  if (originalUrl) process.env["DATABASE_URL"] = originalUrl;
});

describe("the read path's egress purpose", () => {
  it("can be recorded, which means the enum was extended", async () => {
    const rows = await withActor(data.orgA, data.humanA, async (db) => {
      await recordEgress(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        // No section: this call is about a question, not about stored prose.
        purpose: "query-embedding",
        destination: "http://embeddings:8080",
        model: "bge-m3-2026-01-01",
        inputItems: 1,
        inputChars: 42,
      });

      return listEgress(db, data.projectA, pageOf());
    });

    const recorded = rows.items.find((r) => r.purpose === "query-embedding");
    expect(recorded).toBeDefined();
    expect(recorded?.sectionId).toBeNull();
    // A size, never a sample. The disclosure log must not become a second copy
    // of the queries it is describing.
    expect(recorded?.inputChars).toBe(42);
  });

  /**
   * The distinction, at the only layer where a customer can see it.
   *
   * Two calls, both sending text to a model, recorded apart — because one sent
   * a document uploaded last week and the other sent what somebody typed a
   * minute ago, and those are not the same disclosure.
   */
  it("is a different row from the batch embedding of an atom", async () => {
    const rows = await withActor(data.orgA, data.humanA, async (db) => {
      await recordEgress(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        sectionId: data.sectionA,
        purpose: "embedding",
        destination: "https://api.voyageai.com",
        model: "voyage-3",
        inputItems: 8,
        inputChars: 4096,
      });

      return listEgress(db, data.projectA, pageOf());
    });

    const purposes = rows.items.map((r) => r.purpose);
    expect(purposes).toContain("query-embedding");
    expect(purposes).toContain("embedding");

    const batch = rows.items.find((r) => r.purpose === "embedding");
    expect(batch?.sectionId).toBe(data.sectionA);
  });
});

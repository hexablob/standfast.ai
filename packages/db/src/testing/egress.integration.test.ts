import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import { pageOf } from "../pagination.js";
import {
  listEgress,
  recordEgress,
  summarizeEgress,
} from "../repositories/egress.js";
import { adminUrl, ensureTestRole, type Seed, seed } from "./harness.js";

/**
 * The disclosure record, under the tenant boundary.
 *
 * `docs/13-threat-model.md` (*Egress*, rule 3) makes this table the answer to
 * "what left, to which provider, for which project". Three of the four tests
 * below are about what the table refuses rather than what it stores: a
 * disclosure log another tenant can read, or the writer can revise, or that a
 * re-push silently empties, answers the question wrongly in a way nobody
 * notices until it matters.
 */

let data: Seed;
const originalUrl = process.env["DATABASE_URL"];
// Captured before the override below. `adminUrl` reads DATABASE_URL, and every
// test here runs with that variable pointing at the unprivileged role — so a
// later call to it would hand back a connection that is not an admin at all,
// and a DELETE through it would quietly affect nothing.
let superuserUrl = "";

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();
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

const CALL = {
  purpose: "extraction" as const,
  destination: "https://api.example.com",
  model: "some-model-2026-01-01",
  inputItems: 1,
  inputChars: 4_096,
};

describe("the egress record", () => {
  it("says what left, to whom, and how much — and never what", async () => {
    await withActor(data.orgA, data.humanA, (db) =>
      recordEgress(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        sectionId: data.sectionA,
        ...CALL,
      }),
    );

    const { items: rows } = await withActor(data.orgA, data.humanA, (db) =>
      listEgress(db, data.projectA, pageOf()),
    );
    const row = rows[0];
    expect(row?.destination).toBe(CALL.destination);
    expect(row?.model).toBe(CALL.model);
    expect(row?.inputChars).toBe(CALL.inputChars);

    // The measurement is the whole record. If a column ever appears here that
    // could hold the prose itself, this is where it gets caught.
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "at",
      "destination",
      "id",
      "inputChars",
      "inputItems",
      "model",
      "orgId",
      "projectId",
      "purpose",
      "sectionId",
    ]);
  });

  it("groups by the triple the allowlist pins", async () => {
    await withActor(data.orgA, data.humanA, async (db) => {
      // Same purpose and origin, a different pinned version. Collapsing these
      // into one row would lose the thing pinning a version is for.
      await recordEgress(db, {
        orgId: data.orgA,
        projectId: data.projectA,
        ...CALL,
        model: "some-model-2026-06-01",
        inputChars: 100,
      });
    });

    const summary = await withActor(data.orgA, data.humanA, (db) =>
      summarizeEgress(db, data.projectA),
    );
    expect(summary.map((s) => s.model).sort()).toEqual([
      "some-model-2026-01-01",
      "some-model-2026-06-01",
    ]);
    expect(summary.every((s) => s.calls >= 1)).toBe(true);
  });

  it("is invisible to another org", async () => {
    const { items: rows } = await withActor(data.orgB, data.extractorB, (db) =>
      listEgress(db, data.projectA, pageOf()),
    );
    expect(rows).toEqual([]);
  });

  it("cannot be revised or erased by the role that writes it", async () => {
    // Append-only by grant rather than by convention. A process that can edit
    // the log of what it sent has disclosed nothing.
    // Drizzle wraps the driver error, so the assertion reads the SQLSTATE
    // rather than a message that is one library upgrade from changing.
    // 42501 is insufficient_privilege.
    const refused = async (statement: string): Promise<string> => {
      try {
        await withActor(data.orgA, data.humanA, (db) => db.execute(statement));
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause;
        return cause?.code ?? "no code";
      }
      return "not refused";
    };

    expect(await refused("update egress_events set model = 'x'")).toBe("42501");
    expect(await refused("delete from egress_events")).toBe("42501");
  });

  it("survives the deletion of the section whose prose left", async () => {
    // Ordinary churn: a re-push replaces sections. The record of what was sent
    // must not go with them, so the foreign key sets null instead of cascading.
    const admin = new Client({ connectionString: superuserUrl });
    await admin.connect();
    try {
      const deleted = await admin.query(
        "delete from document_sections where id = $1",
        [data.sectionA],
      );
      expect(deleted.rowCount).toBe(1);
    } finally {
      await admin.end();
    }

    const { items: rows } = await withActor(data.orgA, data.humanA, (db) =>
      listEgress(db, data.projectA, pageOf()),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.sectionId === null)).toBe(true);
  });
});

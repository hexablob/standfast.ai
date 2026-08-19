import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import { PAGE_MAX, pageOf } from "../pagination.js";
import { listAtoms } from "../repositories/atoms.js";
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
 * Paging over a list, and the property that makes it worth anything.
 *
 * `docs/14-roadmap.md` wanted pagination because "the envelope's `truncated`
 * flag stops being honest the moment a list endpoint drops rows". These tests
 * are about the two ways that honesty fails: a flag that is wrong, and an order
 * that is not total.
 */

const ATOMS = 7;
let data: Seed;
const originalUrl = process.env["DATABASE_URL"];

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const admin = await adminClient();
  try {
    for (let i = 0; i < ATOMS; i++) {
      // All inserted in one loop, so several share a `created_at` to the
      // microsecond — which is the case the tie-break exists for and the one a
      // hand-made fixture with sleeps between rows would hide.
      await admin.query(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind, status,
            source_quote, source_span)
         values ($1,$2,$3,$4,$5,'decision','provisional',$6,$7::int4range)`,
        [
          data.orgA,
          data.projectA,
          data.documentA,
          data.sectionA,
          `statement number ${i}`,
          QUOTE_A,
          SPAN_A,
        ],
      );
    }
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  if (originalUrl) process.env["DATABASE_URL"] = originalUrl;
});

const list = (limit: number, offset: number) =>
  withActor(data.orgA, data.humanA, (db) =>
    listAtoms(db, data.projectA, pageOf({ limit, offset })),
  );

describe("paging a list", () => {
  it("counts what matched, not what it returned", async () => {
    const page = await list(3, 0);

    expect(page.returned).toBe(3);
    expect(page.total).toBe(ATOMS);
  });

  /**
   * The failure an unstable order causes, and the reason every paginated query
   * orders by something total.
   *
   * With `created_at` alone as the sort key — and these rows share one — the
   * database is free to return them in a different order for each `OFFSET`, so
   * walking the pages yields some rows twice and misses others entirely. No
   * error, no warning, and an export that is quietly incomplete.
   */
  it("visits every row exactly once when walked page by page", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < ATOMS; offset += 2) {
      const page = await list(2, offset);
      seen.push(...page.items.map((a) => a.id));
    }

    expect(seen).toHaveLength(ATOMS);
    expect(new Set(seen).size).toBe(ATOMS);
  });

  it("is truncated while rows remain, and not on the last page", async () => {
    expect((await list(3, 0)).truncated).toBe(true);
    expect((await list(3, 3)).truncated).toBe(true);
    // 6 + 1 = 7, so this page ends the set.
    expect((await list(3, 6)).truncated).toBe(false);
  });

  /**
   * `truncated` is false when the page happens to end exactly on the last row.
   * Reporting it as true — because the page came back full — is the false
   * positive that makes the flag worthless on any list whose length is a
   * multiple of the page size.
   */
  it("is not truncated when a full page is the last one", async () => {
    const exact = await list(ATOMS, 0);

    expect(exact.returned).toBe(ATOMS);
    expect(exact.truncated).toBe(false);
  });

  it("returns nothing, and claims nothing, past the end", async () => {
    const beyond = await list(3, 99);

    expect(beyond.items).toEqual([]);
    expect(beyond.truncated).toBe(false);
  });

  /**
   * The ceiling is a ceiling. Without it `?limit=100000` is a way to ask the
   * API to do the thing pagination was added to stop it doing.
   */
  it("clamps a limit nobody should be allowed to ask for", async () => {
    expect(pageOf({ limit: 100_000 }).limit).toBe(PAGE_MAX);
    expect(pageOf({ limit: 0 }).limit).toBe(1);
    expect(pageOf({ offset: -5 }).offset).toBe(0);
  });
});

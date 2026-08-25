import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../client.js";
import { assertTenantIsolationApplies } from "../guard.js";
import { adminClient, adminUrl, appUrl, ensureTestRole } from "./harness.js";

/**
 * The start-up guard's refusal, driven rather than described.
 *
 * docs/13-threat-model.md called this the least exercised code in the
 * repository: the check that keeps a BYPASSRLS connection from serving was
 * itself asserted by nothing. So this suite creates a real BYPASSRLS login
 * role, points the pool at it, and watches the refusal happen — then makes
 * the same call as the unprivileged role the rest of the suite runs under,
 * the positive control. A guard that refused everyone would fail that one.
 */

const BYPASS_ROLE = "standfast_bypassrls_test";
const BYPASS_PASSWORD = "standfast_bypassrls_test";

function bypassUrl(): string {
  const url = new URL(adminUrl());
  url.username = BYPASS_ROLE;
  url.password = BYPASS_PASSWORD;
  return url.toString();
}

const originalUrl = process.env["DATABASE_URL"];

beforeAll(async () => {
  await ensureTestRole();
  const admin = await adminClient();
  try {
    // NOBYPASSRLS everywhere else in this repository is deliberate. This is
    // the one role that holds BYPASSRLS on purpose: it exists to be refused,
    // and it is dropped again below.
    await admin.query(`DO $$ BEGIN
      CREATE ROLE ${BYPASS_ROLE} LOGIN PASSWORD '${BYPASS_PASSWORD}' BYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  if (originalUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = originalUrl;
  }
  await closePool();

  const admin = await adminClient();
  try {
    await admin.query(`DROP ROLE IF EXISTS ${BYPASS_ROLE}`);
  } finally {
    await admin.end();
  }
});

describe("assertTenantIsolationApplies", () => {
  it("refuses a non-superuser role holding BYPASSRLS", async () => {
    await closePool();
    process.env["DATABASE_URL"] = bypassUrl();

    await expect(assertTenantIsolationApplies()).rejects.toThrow(
      /bypasses row-level security[\s\S]*rolbypassrls=true/,
    );
  });

  it("accepts the unprivileged role the rest of the suite runs under", async () => {
    await closePool();
    process.env["DATABASE_URL"] = appUrl();

    await expect(assertTenantIsolationApplies()).resolves.toBeUndefined();
  });
});

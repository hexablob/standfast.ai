import { Client } from "pg";

/**
 * Test harness for the row-level security suite.
 *
 * Superusers bypass RLS regardless of FORCE ROW LEVEL SECURITY, and the
 * migration role owns the tables. So every assertion about isolation has to
 * run as a non-superuser, non-owner role that is merely a member of
 * `standfast_app`. That is what `appClient()` returns; `adminClient()` is only for
 * seeding and teardown.
 */

const TEST_ROLE = "standfast_test";
const TEST_PASSWORD = "standfast_test";

export function adminUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }
  return url;
}

export function appUrl(): string {
  const url = new URL(adminUrl());
  url.username = TEST_ROLE;
  url.password = TEST_PASSWORD;
  return url.toString();
}

export async function adminClient(): Promise<Client> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  return client;
}

/** A connection subject to RLS. */
export async function appClient(): Promise<Client> {
  const client = new Client({ connectionString: appUrl() });
  await client.connect();
  return client;
}

/**
 * Creates the unprivileged login role the suite connects through, and grants
 * it `standfast_app`. NOBYPASSRLS is explicit: inheriting it would make every
 * isolation test pass for the wrong reason.
 */
export async function ensureTestRole(): Promise<void> {
  const admin = await adminClient();
  try {
    await admin.query(`DO $$ BEGIN
      CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_PASSWORD}' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`);
    await admin.query(`GRANT "standfast_app" TO ${TEST_ROLE}`);
  } finally {
    await admin.end();
  }
}

export type Seed = {
  orgA: string;
  orgB: string;
  humanA: string;
  agentA: string;
  extractorA: string;
  extractorB: string;
  projectA: string;
  documentA: string;
  sectionA: string;
};

/**
 * The body the seeded document and its single section carry.
 *
 * `atoms_verify_quote_insert` compares `source_quote` against the substring
 * `source_span` names, so a fixture can no longer invent either half — a quote
 * has to be text that is genuinely in here. The spans below are derived from
 * the body rather than counted by hand, because a miscount would look exactly
 * like a broken trigger.
 */
export const SECTION_A_BODY = "# A\nQuoted verbatim.";

/**
 * Half-open, zero-based, in Unicode code points — the `int4range` literal the
 * column takes. This text is ASCII, so UTF-16 indices and code points coincide
 * and `indexOf`/`length` are the right measure.
 */
function spanOf(quote: string): string {
  const start = SECTION_A_BODY.indexOf(quote);
  if (start < 0) {
    throw new Error(`fixture quote is not in the seeded body: ${quote}`);
  }
  return `[${start},${start + quote.length})`;
}

/** A quote the trigger accepts, and the span that proves it. */
export const QUOTE_A = "Quoted verbatim.";
export const SPAN_A = spanOf(QUOTE_A);

/**
 * A quote the trigger accepts and `atoms_source_quote_not_blank` rejects: the
 * single space in `# A`. Without a span that genuinely names whitespace, the
 * blank-quote constraint sits behind the trigger and is never reached, so it
 * would be a constraint nothing tests.
 */
export const BLANK_QUOTE_A = " ";
export const BLANK_SPAN_A = spanOf(BLANK_QUOTE_A);

/**
 * Seeds two orgs so that every isolation assertion has something real to fail
 * to see. Runs as the superuser, which bypasses RLS — that is the point:
 * the data exists, and the question under test is whether `standfast_app` can
 * reach across the boundary to it.
 */
export async function seed(): Promise<Seed> {
  const admin = await adminClient();
  try {
    const org = async (slug: string): Promise<string> => {
      const r = await admin.query<{ id: string }>(
        "insert into orgs (name, slug) values ($1, $1) returning id",
        [slug],
      );
      return r.rows[0]?.id ?? "";
    };

    const orgA = await org(`a-${Date.now()}-${process.pid}`);
    const orgB = await org(`b-${Date.now()}-${process.pid}`);

    const actor = async (
      orgId: string,
      kind: "human" | "agent",
      systemKey: string | null = null,
    ): Promise<string> => {
      const r = await admin.query<{ id: string }>(
        "insert into actors (org_id, kind, display_name, system_key) values ($1, $2, $3, $4) returning id",
        [orgId, kind, `${kind} actor`, systemKey],
      );
      return r.rows[0]?.id ?? "";
    };

    const humanA = await actor(orgA, "human");
    const agentA = await actor(orgA, "agent");

    // Both orgs, because a cross-tenant test needs a real target in the org it
    // is not allowed to reach. Created here rather than left to the code under
    // test: production creates these with the org, so a test that mints its own
    // would be exercising a path that does not exist.
    const extractorA = await actor(orgA, "agent", "extractor");
    const extractorB = await actor(orgB, "agent", "extractor");

    const project = await admin.query<{ id: string }>(
      "insert into projects (org_id, name, slug) values ($1, 'A', 'a') returning id",
      [orgA],
    );
    const projectA = project.rows[0]?.id ?? "";

    const document = await admin.query<{ id: string }>(
      `insert into documents (org_id, project_id, path, body, content_hash)
       values ($1, $2, 'docs/a.md', $3, 'hash-a') returning id`,
      [orgA, projectA, SECTION_A_BODY],
    );
    const documentA = document.rows[0]?.id ?? "";

    const section = await admin.query<{ id: string }>(
      `insert into document_sections (org_id, document_id, ordinal, heading_path, body, section_hash)
       values ($1, $2, 0, ARRAY['A'], $3, 'sec-a') returning id`,
      [orgA, documentA, SECTION_A_BODY],
    );
    const sectionA = section.rows[0]?.id ?? "";

    // A document in org B, so cross-tenant reads have a real target.
    const projectB = await admin.query<{ id: string }>(
      "insert into projects (org_id, name, slug) values ($1, 'B', 'b') returning id",
      [orgB],
    );
    await admin.query(
      `insert into documents (org_id, project_id, path, body, content_hash)
       values ($1, $2, 'docs/b.md', '# B secret', 'hash-b')`,
      [orgB, projectB.rows[0]?.id],
    );

    return {
      orgA,
      orgB,
      humanA,
      agentA,
      extractorA,
      extractorB,
      projectA,
      documentA,
      sectionA,
    };
  } finally {
    await admin.end();
  }
}

/** Runs `fn` with the tenant GUC set, exactly as `withActor` would. */
export async function asOrg<T>(
  client: Client,
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('standfast.org_id', $1, true)", [
      orgId,
    ]);
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

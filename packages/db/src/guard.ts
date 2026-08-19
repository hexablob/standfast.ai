import { getPool } from "./client.js";

/**
 * Refuses to serve on a connection that bypasses row-level security.
 *
 * A superuser bypasses RLS regardless of FORCE, and so does any role holding
 * BYPASSRLS. Connect the API as one and every policy in migration 0000 stops
 * applying: every request sees every org's rows, with no error, no warning and
 * nothing in the logs. The application behaves perfectly. It just has no
 * tenant isolation.
 *
 * This is not hypothetical — it is what `DATABASE_URL=postgres://postgres@…`
 * does, which is the first connection string anyone reaches for locally.
 *
 * `docs/02-principles.md` (2): privacy boundaries are enforced at the wire,
 * and a guarantee you can attempt to break and watch fail is worth more than a
 * policy statement. This is the check that makes the failure loud.
 */
export async function assertTenantIsolationApplies(): Promise<void> {
  const result = await getPool().query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `select rolname, rolsuper, rolbypassrls
       from pg_roles where rolname = current_user`,
  );

  const role = result.rows[0];
  if (!role) {
    throw new Error("Could not determine the current database role.");
  }

  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      [
        `Refusing to start: the database role "${role.rolname}" bypasses row-level security`,
        `(rolsuper=${role.rolsuper}, rolbypassrls=${role.rolbypassrls}).`,
        "",
        "Every tenant policy would be silently inactive and every request would",
        "see every organisation's data.",
        "",
        "Connect as a role granted standfast_app instead:",
        "",
        "  CREATE ROLE standfast_api LOGIN PASSWORD '…' NOBYPASSRLS;",
        "  GRANT standfast_app TO standfast_api;",
        "",
        "Migrations still run as the owner; only the API needs the restricted role.",
      ].join("\n"),
    );
  }
}

/**
 * The pgvector version iterative index scans arrived in.
 *
 * Below this, `hnsw.iterative_scan` is not a setting — it is an unknown GUC,
 * and `set_config` on one raises rather than being ignored, so the failure
 * would surface as a broken retrieval request rather than as a refusal to
 * start.
 */
export const MINIMUM_PGVECTOR_VERSION = "0.8.0";

/**
 * Refuses to serve on a pgvector too old to mitigate the RLS interaction.
 *
 * `docs/06-retrieval.md` (*Tenancy, and the one place it interacts badly with
 * ANN*) names why the **version** joins the start-up assertions rather than the
 * mere presence of the extension. An HNSW scan visits a bounded number of
 * neighbours and the policy filters afterwards, so a tenant holding a small
 * share of a large table can get `ef_search` rows that all belong to other
 * organisations, have every one removed, and be told there is nothing — with
 * matching rows sitting in the table. No error, no warning, correct-looking
 * behaviour, no results.
 *
 * That is the same shape of failure as the superuser case above: one that looks
 * like health. So it gets the same treatment — a refusal at boot with a message
 * naming the fix, rather than a discovery at a customer.
 *
 * Compared numerically per component. String comparison puts "0.10.0" below
 * "0.8.0", which would refuse to start on a version that is newer than the one
 * required — a check that fails closed in the wrong direction is still a bug.
 */
export async function assertVectorSearchSupported(): Promise<void> {
  const result = await getPool().query<{ extversion: string }>(
    `select extversion from pg_extension where extname = 'vector'`,
  );

  const installed = result.rows[0]?.extversion;
  if (!installed) {
    throw new Error(
      "Refusing to start: the pgvector extension is not installed. Migration 0000 creates it; run migrations before starting.",
    );
  }

  if (compareVersions(installed, MINIMUM_PGVECTOR_VERSION) < 0) {
    throw new Error(
      [
        `Refusing to start: pgvector ${installed} is installed and retrieval needs at least ${MINIMUM_PGVECTOR_VERSION}.`,
        "",
        "Iterative index scans arrived in 0.8.0. Without them, a tenant holding a",
        "small share of a large table can have every row an HNSW traversal",
        "returned removed by its row-level security policy, and receive an empty",
        "result with matching rows still in the table — no error, no warning.",
        "",
        "Upgrade the extension on the server, then:",
        "",
        "  ALTER EXTENSION vector UPDATE;",
      ].join("\n"),
    );
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

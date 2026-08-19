/**
 * Creates the first org, a human actor and an API key.
 *
 * This is ops tooling, run over the owner connection, and it is deliberately
 * not an API endpoint. An unauthenticated route that mints the first
 * credential is an unauthenticated route that mints credentials, and "only
 * when the table is empty" is a race, not a guard.
 *
 *   pnpm --filter @standfast/db run bootstrap "My org" "Jane"
 *
 * The key is printed once and never again — only its SHA-256 is stored.
 */
import { Client } from "pg";
import { generateApiKey } from "./auth.js";

async function main(): Promise<void> {
  const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }

  const orgName = process.argv[2] ?? "Default org";
  const actorName = process.argv[3] ?? "Owner";
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query("begin");

    const org = await client.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $2) returning id",
      [orgName, slug],
    );
    const orgId = org.rows[0]?.id;

    const actor = await client.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', $2) returning id",
      [orgId, actorName],
    );
    const actorId = actor.rows[0]?.id;

    // The org's extractor, created with the org rather than by the worker.
    // docs/05-extraction.md attributes every extracted atom to it, and minting
    // it lazily from inside a job is how one org ends up with two after a race.
    // It cannot ratify anything: `actors` is unique on (id, kind) and `atoms`
    // references (id, 'human'), so an agent is unrepresentable as a ratifier.
    const extractor = await client.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor') returning id",
      [orgId],
    );
    const extractorId = extractor.rows[0]?.id;

    const { key, prefix, hash } = generateApiKey();
    await client.query(
      "insert into api_keys (org_id, actor_id, prefix, hash, scopes) values ($1, $2, $3, $4, $5)",
      [orgId, actorId, prefix, hash, ["read", "write"]],
    );

    await client.query("commit");

    console.error(`org      ${orgId}  (${slug})`);
    console.error(`actor    ${actorId}  (human, ${actorName})`);
    console.error(`agent    ${extractorId}  (agent, extractor)`);
    console.error("");
    console.error("API key — shown once, only its SHA-256 is stored:");
    console.error("");
    console.error(`  ${key}`);
    console.error("");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

await main();

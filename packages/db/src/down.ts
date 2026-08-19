/**
 * Reverses every applied migration, newest first.
 *
 * drizzle-kit generates forward-only SQL. The reverse half is hand-written
 * as a `NNNN_*.down.sql` sibling, and this runner is what makes the pair
 * mean something: CI runs up, then down, then up again, and a migration
 * that cannot survive that round trip does not merge.
 *
 * This reverses *all* migrations rather than one step. That is what the CI
 * round trip needs, and a partial rollback of a schema that has already
 * been deployed is a decision for a human, not a script.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

async function downFilesNewestFirst(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  return entries
    .filter((f) => f.endsWith(".down.sql"))
    .sort()
    .reverse();
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }

  const files = await downFilesNewestFirst();
  if (files.length === 0) {
    console.error("No reverse migrations found — nothing to undo.");
    return;
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      console.error(`↓ ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    // Drop drizzle's journal last. Every object it recorded is gone by now,
    // so leaving the journal behind would make the next `db:migrate` skip
    // migrations whose tables no longer exist.
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  } finally {
    await client.end();
  }
}

await main();

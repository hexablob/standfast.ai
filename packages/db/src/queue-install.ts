import { PgBoss } from "pg-boss";
import { QUEUE_SCHEMA, SECTION_EXTRACT_QUEUE } from "./queue.js";

/**
 * Installs pg-boss's own tables into the schema migration `0005_queue` created,
 * and declares the queues.
 *
 * Runs as the owner, over `DIRECT_URL`, and is idempotent. This is the second
 * required step after `pnpm db:migrate`; that split is what keeps pg-boss's
 * generated DDL out of this repository's migration history and lets its own
 * version ledger stay the only one.
 *
 * Queues are declared here and never at runtime. The restricted role has USAGE
 * on the schema and not CREATE, so a `createQueue()` from a serving process
 * fails rather than quietly succeeding — which is what makes "declared at
 * install time" a property instead of a habit.
 */
export async function installQueue(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    migrate: true,
    createSchema: false,
    supervise: false,
    schedule: false,
    useListenNotify: false,
  });

  await boss.start();

  // `partition: false` is the default and is what we want: the queue is a row
  // in pgboss.queue, not a table of its own, so the restricted role never needs
  // CREATE for a queue to exist.
  await boss.createQueue(SECTION_EXTRACT_QUEUE, {
    retryLimit: 3,
    retryBackoff: true,
  });

  // Belt and braces. ALTER DEFAULT PRIVILEGES in 0005 covers objects created by
  // the role that ran the migration; this covers the case where the install ran
  // as somebody else. Granting twice is free; discovering the gap from a
  // permission error in a worker at 3am is not.
  await boss
    .getDb()
    .executeSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${QUEUE_SCHEMA}" TO "standfast_app"`,
      [],
    );
  await boss
    .getDb()
    .executeSql(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${QUEUE_SCHEMA}" TO "standfast_app"`,
      [],
    );

  await boss.stop({ graceful: true });
}

async function main(): Promise<void> {
  // DIRECT_URL, not DATABASE_URL. This needs the owner, and DATABASE_URL is
  // documented as the restricted, possibly pooled connection the API serves on.
  const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    console.error("queue:install needs DIRECT_URL (or DATABASE_URL) to be set");
    process.exit(2);
  }

  await installQueue(url);
  console.error(
    `queue installed: schema ${QUEUE_SCHEMA}, ${SECTION_EXTRACT_QUEUE}`,
  );
}

if (process.argv[1]?.endsWith("queue-install.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

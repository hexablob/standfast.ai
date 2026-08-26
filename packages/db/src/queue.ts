import { sql } from "drizzle-orm";
import { type ConstructorOptions, fromDrizzle, PgBoss } from "pg-boss";
import type { Db } from "./client.js";
import { getPool } from "./client.js";

/**
 * The schema pg-boss owns. Created, and granted on, by migration `0005_queue`;
 * populated by `pnpm db:queue:install`. Never `public`, so the wire-allowlist
 * guard — which compares against `table_schema = 'public'` — is not asked to
 * have an opinion about a vendor's tables.
 */
export const QUEUE_SCHEMA = "pgboss";

/**
 * The only job type. docs/05-extraction.md settles this: one section in, zero
 * or more provisional atoms out, and no document-level fan-out job. A fan-out
 * job would have to re-derive the section list that `putDocument` already
 * computed inside the write transaction.
 */
export const SECTION_EXTRACT_QUEUE = "section.extract";

/**
 * How long one section gets before its model call is aborted.
 *
 * Lives beside the queue name because two things have to agree with it: the
 * signal the handler is handed, and how long a graceful shutdown is willing to
 * wait for the job in flight. pg-boss's own lease — `expire_seconds`, 900 by
 * default — is deliberately far larger and is not a second opinion on this
 * number: it exists to recover a job whose *process* died, not one whose model
 * call is slow.
 */
export const SECTION_EXTRACT_DEADLINE_MS = 120_000;

/**
 * What a worker is handed. Every field is a capability the enqueuer already
 * held: it is written from inside a `withActor` transaction, and no part of it
 * comes from client input.
 */
export type SectionExtractJob = {
  readonly orgId: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly sectionId: string;
  readonly extractorVersion: string;
};

/**
 * Enqueues one extraction job on a caller-supplied transaction.
 *
 * The port exists so `putDocument` can be tested without a queue, and so the
 * enqueue can be observed. See `enqueueSectionExtract` for the real one.
 */
export type EnqueueSectionExtract = (
  db: Db,
  job: SectionExtractJob,
  /**
   * Where this job sits in the batch it was enqueued with, counted down from
   * the batch size so the first section has the highest number.
   *
   * pg-boss fetches `ORDER BY priority desc, created_on, id`. Every job sent
   * inside one transaction shares `created_on` — it is the transaction
   * timestamp — so without this the tie breaks on a uuid, and the order two
   * sections of one document are processed in is random. Deduplication is
   * first-writer-wins, so that would make which of two similar atoms survives a
   * coin flip, and a rebuild would not reproduce its own corpus.
   */
  priority?: number,
) => Promise<void>;

let boss: PgBoss | undefined;
let started: Promise<PgBoss> | undefined;
let supervising = false;

/**
 * Declares that this process runs pg-boss's maintenance. Must be called before
 * anything opens the queue.
 *
 * Maintenance is the only thing that returns a job whose worker died to the
 * queue. `retryLimit` governs a handler that threw; a process killed
 * mid-execution never throws, so its job stays `active` until pg-boss's `Boss`
 * expires the lease — and `Boss` is started only when `supervise` is true. A
 * worker without this strands every job it was holding when it was killed.
 *
 * Deliberately a role a process states once, rather than an argument to
 * `getBoss()`. The handle is memoised process-wide, so per-call options would
 * mean whichever caller happened to run first silently decided for all of them.
 * With no options to pass there is nothing to disagree about; the only way left
 * to get it wrong is to call this too late, and that throws.
 */
export function superviseQueue(): void {
  if (started) {
    throw new Error(
      "superviseQueue() must run before the queue is opened — the handle is already started and its options are fixed.",
    );
  }
  supervising = true;
}

/**
 * The options this process opens pg-boss with.
 *
 * Exported so a test can assert on what a process actually constructs rather
 * than on a comment claiming what it constructs.
 */
export function queueOptions() {
  return {
    db: {
      executeSql: async (text: string, values: unknown[]) => {
        const result = await getPool().query(text, values as never[]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    },
    schema: QUEUE_SCHEMA,

    // The install step migrates; a serving process never does. With
    // `migrate: false`, pg-boss checks the installed schema version at start
    // and throws "pg-boss is not installed" or "requires migrations" — which is
    // the loud failure wanted, and it comes for free.
    migrate: false,
    createSchema: false,

    // DATABASE_URL may be a pooler, and a LISTEN session cannot survive one.
    // Polling is the correct default here; the worker sets its own interval.
    useListenNotify: false,

    // Off unless this process said otherwise: a sender has no job of its own to
    // recover, and every supervisor competes for the same maintenance lock.
    supervise: supervising,

    // Nothing here is on a cron.
    schedule: false,
  } satisfies ConstructorOptions;
}

/**
 * The process-wide pg-boss handle, started once.
 *
 * `start()` is not optional even for a process that only sends: `send()` reads
 * a queue cache that `start()` primes, and asserts on it. The cache read goes
 * to pg-boss's own connection rather than to the caller's transaction, which is
 * why it happens once at boot rather than inside a write.
 */
export async function getBoss(): Promise<PgBoss> {
  if (started) return started;

  started = (async () => {
    const instance = new PgBoss(queueOptions());

    // pg-boss reports background failures — a fetch that lost its connection, a
    // maintenance sweep that could not take its lock — as an `error` event, and
    // an `error` event with no listener terminates the process. Both defaults
    // are wrong here. Terminating kills whatever the worker is extracting and
    // leaves behind exactly the stranded `active` job that supervision exists to
    // recover; swallowing hides a queue that has quietly stopped maintaining
    // itself. Attached here rather than in each caller because every process
    // that opens the queue is exposed, including the ones that only send.
    instance.on("error", (error: unknown) => {
      console.error("pg-boss:", error);
    });

    await instance.start();
    boss = instance;
    return instance;
  })();

  return started;
}

/**
 * Sends a `section.extract` job **inside the caller's transaction**.
 *
 * This is the whole of "transactional enqueue is mandatory". `fromDrizzle`
 * routes pg-boss's insert through the same handle as the document write, so a
 * rolled-back push leaves no job behind — and a job that survives a rolled-back
 * write is a job that extracts from a document that does not exist.
 *
 * Deliberately no deterministic job id. pg-boss's insert ends in
 * `ON CONFLICT DO NOTHING`, so a fixed id would look like idempotency; but
 * completed jobs are retained, so it would block the legitimate re-enqueue that
 * exit criterion 3 depends on. Idempotency lives where the schema put it:
 * `section_extractions` unique on `(section_id, extractor_version)`.
 */
export const enqueueSectionExtract: EnqueueSectionExtract = async (
  db,
  job,
  priority = 0,
) => {
  const instance = await getBoss();
  await instance.send(SECTION_EXTRACT_QUEUE, job, {
    db: fromDrizzle(db as never, sql),
    priority,
  });
};

export async function stopBoss(): Promise<void> {
  if (boss) {
    // `graceful` stops fetching and waits for the job in flight. pg-boss's
    // default wait is 30s — shorter than the deadline that job was given — so a
    // worker shut down mid-extraction would have its work failed and retried for
    // no reason other than the two numbers disagreeing. Waiting the deadline out
    // costs nothing when nothing is in flight: pg-boss polls for pending work
    // rather than sleeping out the timeout.
    await boss.stop({ graceful: true, timeout: SECTION_EXTRACT_DEADLINE_MS });
    boss = undefined;
    started = undefined;
    supervising = false;
  }
}

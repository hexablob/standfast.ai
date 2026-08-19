import {
  getBoss,
  SECTION_EXTRACT_QUEUE,
  type SectionExtractJob,
} from "@standfast/db";

export type DrainResult = {
  readonly handled: number;
  readonly failed: number;
};

/**
 * Runs every queued job to completion, then returns.
 *
 * Deliberately `fetch`/`complete`/`fail` rather than `work()` and a poll loop.
 * `work()` is the right shape for a long-lived process and the wrong one for a
 * test: it would make the suite's slowest and flakiest assertions depend on
 * wall-clock timing. This exercises the same fetch path — the job genuinely
 * leaves the queue — with no timing dependence at all.
 */
export async function drain(
  handle: (job: SectionExtractJob, signal: AbortSignal) => Promise<unknown>,
  options: { readonly batchSize?: number; readonly timeoutMs?: number } = {},
): Promise<DrainResult> {
  const boss = await getBoss();
  let handled = 0;
  let failed = 0;

  for (;;) {
    const jobs = await boss.fetch<SectionExtractJob>(SECTION_EXTRACT_QUEUE, {
      batchSize: options.batchSize ?? 20,
    });
    if (jobs.length === 0) return { handled, failed };

    for (const job of jobs) {
      try {
        await handle(
          job.data,
          AbortSignal.timeout(options.timeoutMs ?? 30_000),
        );
        await boss.complete(SECTION_EXTRACT_QUEUE, job.id);
        handled += 1;
      } catch (error) {
        await boss.fail(SECTION_EXTRACT_QUEUE, job.id, {
          message: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
      }
    }
  }
}

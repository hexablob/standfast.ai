import { queueOptions } from "@standfast/db";
import { afterEach, describe, expect, it } from "vitest";
import { becomeWorker } from "./main.js";

/**
 * Signal handlers are process-wide and outlive the test that registered them.
 * Anything this file adds is removed again; anything vitest itself registered is
 * left alone, which rules out taking the runner's own SIGINT handling with it.
 */
const signals = ["SIGINT", "SIGTERM"] as const;
const preexisting = new Set(signals.flatMap((s) => process.listeners(s)));

afterEach(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!preexisting.has(listener)) process.removeListener(signal, listener);
    }
  }
});

describe("becomeWorker", () => {
  it("opens the queue with supervision, so a job stranded by its own death is recovered", () => {
    becomeWorker(() => {});

    expect(queueOptions().supervise).toBe(true);
  });

  for (const signal of signals) {
    it(`stops the queue before the pool on ${signal}`, async () => {
      const codes: number[] = [];
      becomeWorker((code) => codes.push(code));

      process.emit(signal);

      await expect.poll(() => codes).toEqual([0]);
    });
  }

  it("ignores a second signal rather than racing the shutdown already running", async () => {
    const codes: number[] = [];
    becomeWorker((code) => codes.push(code));

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");

    await expect.poll(() => codes).toEqual([0]);
  });
});

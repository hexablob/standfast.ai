import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fresh module per test. The role a process declares is deliberately
 * process-wide state, so two tests sharing one module instance would share the
 * declaration too and the second would prove nothing.
 */
beforeEach(() => {
  vi.resetModules();
});

describe("queue role", () => {
  it("opens without supervision, so a process that only sends runs no maintenance", async () => {
    const { queueOptions } = await import("./queue.js");

    expect(queueOptions().supervise).toBe(false);
  });

  it("supervises once a process declares that it does", async () => {
    const { queueOptions, superviseQueue } = await import("./queue.js");

    superviseQueue();

    expect(queueOptions().supervise).toBe(true);
  });
});

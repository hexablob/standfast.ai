import { afterEach, describe, expect, it } from "vitest";
import { main } from "./bin.js";

/**
 * The commands that refuse are worth a test precisely because they look like
 * successes: exit 0, no error, nothing red. What must hold is that the refusal
 * is *printed* — a skip nobody sees is indistinguishable from a pass.
 */

const written: string[] = [];
const write = process.stdout.write;

function capture(): void {
  process.stdout.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
}

afterEach(() => {
  process.stdout.write = write;
  written.length = 0;
});

describe("pnpm eval retrieval", () => {
  it("skips loudly and succeeds while no labelled queries exist", async () => {
    capture();
    const code = await main(["retrieval"]);
    process.stdout.write = write;

    // Zero, not one: an unmeasurable metric is not a failing metric, and a
    // command that failed here would push somebody to make it stop failing.
    expect(code).toBe(0);

    const output = written.join("");
    expect(output).toContain("SKIPPED  retrieval_precision_under_budget");
    expect(output).toContain("no labelled queries exist");
    expect(output).toContain("never from the atom list");
  });
});

describe("pnpm eval reconciliation", () => {
  it("skips loudly and succeeds while no edit corpus exists", async () => {
    capture();
    const code = await main(["reconciliation"]);
    process.stdout.write = write;

    expect(code).toBe(0);

    const output = written.join("");
    expect(output).toContain("SKIPPED  reconciliation_false_positive_rate");
    expect(output).toContain("no corpus of edits exists");
    expect(output).toContain("hard threshold");
    expect(output).toContain("how hard someone tried");
  });
});

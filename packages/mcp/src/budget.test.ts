import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DESCRIPTIONS, RECONCILE_INPUT, TITLES } from "./tools.js";

/**
 * The tool-description budget from docs/08-mcp-server.md, enforced.
 *
 * Every description is sent on every request of every session, in every
 * client, forever. It is the only cost in the system that is paid even when
 * nobody calls anything, which is why the catalogue is capped at ten tools and
 * why this file exists.
 *
 * The budget is stated in tokens; this measures characters, because a real
 * tokenizer would be a dependency for a build-time check. Four characters per
 * token is the usual approximation for English prose, so 1200 tokens is about
 * 4800 characters. The approximation is stated rather than hidden: if it ever
 * matters at the margin, the fix is a tokenizer, not a bigger number.
 */

const TOKEN_BUDGET = 1200;
const CHARS_PER_TOKEN = 4;
const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN;

describe("tool description budget", () => {
  it(`stays under ~${TOKEN_BUDGET} tokens across the whole catalogue`, () => {
    const surface = [
      ...Object.values(DESCRIPTIONS),
      ...Object.values(TITLES),
    ].join(" ");

    expect(surface.length).toBeLessThanOrEqual(CHAR_BUDGET);
  });

  // Ten is the cap, not the target. docs/08-mcp-server.md specifies six and
  // leaves four unspent; all six now exist, `reconcile` having arrived with
  // phase 3. This is the last tool the specification names.
  it("ships the six specified tools and no others", () => {
    expect(Object.keys(DESCRIPTIONS).sort()).toEqual([
      "context",
      "propose",
      "read",
      "reconcile",
      "search",
      "status",
    ]);
  });

  /**
   * The four unspent slots are a budget, not an oversight
   * (`docs/02-principles.md`, 3). This fails the build on a **seventh** tool
   * arriving without the per-session token cost being discussed, which is the
   * whole mechanism. The six the specification names are now all here, so from
   * this point on every trip of this assertion is a tool nobody agreed to.
   */
  it("leaves the four unspent slots unspent", () => {
    expect(Object.keys(DESCRIPTIONS).length).toBeLessThanOrEqual(6);
  });

  // The absence is the design: an agent cannot promote its own knowledge, so
  // the surface must not suggest that it might.
  it("offers no way to ratify", () => {
    const surface = JSON.stringify({ DESCRIPTIONS, TITLES }).toLowerCase();
    expect(surface).not.toContain("ratify anything");
    expect(Object.keys(DESCRIPTIONS)).not.toContain("ratify");
  });

  it("tells the agent, in propose, that it cannot ratify", () => {
    expect(DESCRIPTIONS.propose.toLowerCase()).toContain("only a human");
  });
});

/**
 * The MCP SDK builds its input validator by wrapping a `ZodRawShape` in a plain
 * `z.object(...)`, and a plain object schema *strips* unknown keys rather than
 * refusing them. That default is the wrong one here: an agent that attaches a
 * `snippet` would have it silently dropped and be told the call succeeded,
 * which reads as permission and means it keeps sending. The item schema is
 * `.strict()` for that reason, and this is the test that notices if it stops
 * being.
 */
describe("reconcile refuses rather than strips", () => {
  const item = {
    atomId: "3f1a5c8e-1b2d-4e6f-8a90-1c2d3e4f5a6b",
    verdict: "honored",
    filePath: "src/a.ts",
  };

  const schema = z.object(RECONCILE_INPUT);

  it("accepts a well-formed submission", () => {
    const parsed = schema.safeParse({
      projectId: "6b1a5c8e-1b2d-4e6f-8a90-1c2d3e4f5a6b",
      items: [item],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    "snippet",
    "code",
    "diff",
    "excerpt",
    "source",
    "contentHash",
    "before",
  ])("refuses an item carrying %s, and does not strip it", (field) => {
    const parsed = schema.safeParse({
      projectId: "6b1a5c8e-1b2d-4e6f-8a90-1c2d3e4f5a6b",
      items: [{ ...item, [field]: "export function f() { return 1; }" }],
    });

    expect(parsed.success).toBe(false);
    // Not merely "did not survive": the failure has to name the key, because a
    // strip and a refusal both leave the field out of the parsed value and only
    // one of them tells the agent to stop.
    expect(JSON.stringify(parsed.error?.issues)).toMatch(
      /unrecognized|not allowed|invalid_key|snippet|code|diff|excerpt|source|contentHash|before/i,
    );
  });
});

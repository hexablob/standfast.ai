import { describe, expect, it } from "vitest";
import { DESCRIPTIONS, TITLES } from "./tools.js";

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
  // leaves four unspent; five of the six exist. `reconcile` is phase 3 and is
  // deliberately not stubbed.
  it("ships the five specified tools and no others", () => {
    expect(Object.keys(DESCRIPTIONS).sort()).toEqual([
      "context",
      "propose",
      "read",
      "search",
      "status",
    ]);
  });

  /**
   * The four unspent slots are a budget, not an oversight
   * (`docs/02-principles.md`, 3). This fails the build on a sixth tool arriving
   * without the per-session token cost being discussed, which is the whole
   * mechanism.
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

import type { StandfastClient } from "@standfast/sdk";
import { describe, expect, it } from "vitest";
import {
  approximateTokens,
  MINIMUM_PROMPT_CHARS,
  renderPack,
  runSessionStart,
  runUserPromptSubmit,
  SESSION_START_BUDGET_TOKENS,
  USER_PROMPT_BUDGET_TOKENS,
} from "./hooks.js";

const PACK = {
  items: [
    {
      atomId: "11111111-1111-4111-8111-111111111111",
      statement: "packages/core is pure domain: no I/O.",
      kind: "constraint",
      provenance: "CLAUDE.md#Code conventions",
    },
  ],
  total: 1,
  returned: 1,
  truncated: false,
  budgetTokensUsed: 120,
  skipped: [],
};

type Call = { body: Record<string, unknown> };

/**
 * A client that never touches the network.
 *
 * Only `POST` is used by the hooks, so only `POST` is stubbed; anything else
 * reaching this object is a change in what the hooks do and should fail loudly.
 */
function stubClient(
  respond: () => { data?: unknown; error?: unknown } | Promise<never>,
): { client: StandfastClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    POST: async (_path: string, options: { body: Record<string, unknown> }) => {
      calls.push({ body: options.body });
      return respond();
    },
  } as unknown as StandfastClient;
  return { client, calls };
}

const PROJECT = "22222222-2222-4222-8222-222222222222";
const LONG_PROMPT = "Refactor the retrieval fusion to add a fifth generator";

describe("runSessionStart", () => {
  it("injects a pack when there is one", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    const outcome = await runSessionStart(client, PROJECT);

    expect(outcome.additionalContext).toContain("packages/core is pure domain");
    expect(outcome.diagnostic).toBeNull();
    expect(calls).toHaveLength(1);
  });

  /**
   * `docs/06-retrieval.md`: at session start there is nothing to describe yet,
   * so the call carries no query. That is what makes it generator 4 alone —
   * a btree and a sort, with no model call on the highest-frequency path in
   * the system.
   */
  it("asks with no query at all, so cold start reaches no model", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    await runSessionStart(client, PROJECT);

    expect(calls[0]?.body["scope"]).toBe("project");
    expect(calls[0]?.body["query"]).toBeUndefined();
  });

  /**
   * `docs/09-agent-contract.md`: pushed context arrived unrequested, so the
   * push side is conservative by default. Pinned against the tool's own
   * default, because a hook that spends a session's budget before the model
   * has asked anything is the version of this feature people switch off.
   */
  it("spends less than the tool an agent would have called itself", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    await runSessionStart(client, PROJECT);

    expect(calls[0]?.body["budgetTokens"]).toBe(SESSION_START_BUDGET_TOKENS);
    expect(SESSION_START_BUDGET_TOKENS).toBeLessThan(2000);
    expect(USER_PROMPT_BUDGET_TOKENS).toBeLessThan(SESSION_START_BUDGET_TOKENS);
  });

  /**
   * Roadmap phase 2, exit criterion 7 — the test it names.
   *
   * Four ways to fail, one outcome each time: no injection, one line of
   * diagnostic, and nothing thrown. A hook that raises takes the session with
   * it on some clients, which would make Standfast a liability at exactly the
   * moment it is least useful.
   */
  it.each([
    ["transport error", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["an API error", () => ({ error: { error: "Invalid API key." } })],
    ["no data and no error", () => ({})],
    [
      "a body that is not a pack",
      () => ({ data: { nonsense: true } as unknown }),
    ],
  ])("does not block the session on %s", async (_name, respond) => {
    const { client } = stubClient(respond as () => { data?: unknown });

    const outcome = await runSessionStart(client, PROJECT);

    expect(outcome.additionalContext).toBeNull();
    expect(outcome.tokens).toBe(0);
  });

  it("says nothing at all when no project is configured", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    const outcome = await runSessionStart(client, undefined);

    // Silent, not merely harmless. A developer who has not linked this
    // repository should not read a complaint on every session.
    expect(outcome).toEqual({
      additionalContext: null,
      diagnostic: null,
      tokens: 0,
    });
    expect(calls).toEqual([]);
  });

  /**
   * An empty pack is a valid answer, and a heading over an empty list still
   * costs tokens while reading as a claim that there is nothing to know.
   */
  it("injects nothing for a project with no canonical atoms", async () => {
    const { client } = stubClient(() => ({
      data: { ...PACK, items: [], total: 0, returned: 0 },
    }));

    const outcome = await runSessionStart(client, PROJECT);

    expect(outcome.additionalContext).toBeNull();
    expect(outcome.tokens).toBe(0);
  });

  it("reports what the injection cost, rather than leaving it to be discovered", async () => {
    const { client } = stubClient(() => ({ data: PACK }));

    const outcome = await runSessionStart(client, PROJECT);

    expect(outcome.tokens).toBeGreaterThan(0);
    expect(outcome.tokens).toBe(
      approximateTokens(outcome.additionalContext ?? ""),
    );
  });
});

describe("runUserPromptSubmit", () => {
  it("passes the prompt through as the query", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    await runUserPromptSubmit(client, PROJECT, LONG_PROMPT);

    expect(calls[0]?.body["query"]).toBe(LONG_PROMPT);
    expect(calls[0]?.body["scope"]).toBe("task");
  });

  /**
   * "ok", "continue" and "yes" carry no retrievable intent. Embedding them
   * spends a model call and a slice of budget to retrieve noise, on every turn.
   */
  it("does not fire on a prompt too short to carry intent", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    const outcome = await runUserPromptSubmit(client, PROJECT, "ok");

    expect(outcome.additionalContext).toBeNull();
    expect(calls).toEqual([]);
    expect("ok".length).toBeLessThan(MINIMUM_PROMPT_CHARS);
  });

  it("does not block the turn when retrieval fails", async () => {
    const { client } = stubClient(() => Promise.reject(new Error("timeout")));

    const outcome = await runUserPromptSubmit(client, PROJECT, LONG_PROMPT);

    expect(outcome.additionalContext).toBeNull();
    expect(outcome.diagnostic).toContain("UserPromptSubmit");
  });
});

describe("renderPack", () => {
  /**
   * `docs/09-agent-contract.md`: an agent should be able to tell what it asked
   * for from what it was handed. Pulled context was chosen; pushed context
   * arrived.
   */
  it("labels the injection as unrequested", () => {
    const rendered = renderPack(PACK, "SessionStart");

    expect(rendered).toContain("Injected automatically");
    expect(rendered).toContain("You did not request this");
  });

  /**
   * `docs/02-principles.md` (13): a canonical atom is a directive injected into
   * every future session. This is literally that injection, so every line says
   * where it came from.
   */
  it("carries provenance on every atom", () => {
    const rendered = renderPack(PACK, "SessionStart");

    expect(rendered).toContain("CLAUDE.md#Code conventions");
  });

  it("says so in prose when the pack is partial", () => {
    const rendered = renderPack(
      { ...PACK, truncated: true, total: 40, returned: 1 },
      "SessionStart",
    );

    expect(rendered).toContain("partial view");
    expect(rendered).toContain("1 of 40");
  });

  it("names the stages that did not run", () => {
    const rendered = renderPack(
      { ...PACK, skipped: ["dense", "reranker"] },
      "SessionStart",
    );

    expect(rendered).toContain("dense, reranker");
  });

  it("does not claim a partial view when nothing was dropped", () => {
    expect(renderPack(PACK, "SessionStart")).not.toContain("partial view");
  });
});

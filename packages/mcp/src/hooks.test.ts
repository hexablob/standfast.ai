import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandfastClient } from "@standfast/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  approximateTokens,
  EDIT_TOOLS,
  MINIMUM_PROMPT_CHARS,
  POST_TOOL_USE_BUDGET_TOKENS,
  renderCheck,
  renderPack,
  runPostToolUse,
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
const FILE = "packages/core/src/pack.ts";

/**
 * `runPostToolUse` remembers what it has already checked in a file keyed by
 * session id, so tests that share one would dedupe against each other and pass
 * for the wrong reason. A fresh id per test, removed afterwards.
 */
const ledgers: string[] = [];

function freshSession(): string {
  const id = randomUUID();
  ledgers.push(join(tmpdir(), `standfast-hook-${id}.txt`));
  return id;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    rmSync(ledger, { force: true });
  }
});

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
    // The API's real 404 body: an unknown project, or one belonging to another
    // org — docs/09-agent-contract.md's failure table, resolved as silence.
    [
      "a cross-org or unknown project (404)",
      () => ({ error: { error: "Not found, or belongs to another org" } }),
    ],
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

  /**
   * docs/09-agent-contract.md, "Project not found": ask which project — and
   * never create one. A hook cannot ask, so the whole row reduces to this:
   * exactly one request went out. No retry, and no second call of any kind
   * that could quietly create a project on the agent's behalf.
   */
  it("makes exactly one request on a 404 — no retry, nothing that could create a project", async () => {
    const { client, calls } = stubClient(() => ({
      error: { error: "Not found, or belongs to another org" },
    }));

    await runSessionStart(client, PROJECT);

    expect(calls).toHaveLength(1);
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

  it.each([
    ["a transport error", () => Promise.reject(new Error("timeout"))],
    // Same 404 body as the other two hooks' tables: an unknown or cross-org
    // project degrades to one diagnostic line, never a blocked turn.
    [
      "a cross-org or unknown project (404)",
      () => ({ error: { error: "Not found, or belongs to another org" } }),
    ],
  ])(
    "does not block the turn when retrieval fails on %s",
    async (_name, respond) => {
      const { client } = stubClient(respond as () => { data?: unknown });

      const outcome = await runUserPromptSubmit(client, PROJECT, LONG_PROMPT);

      expect(outcome.additionalContext).toBeNull();
      expect(outcome.diagnostic).toContain("UserPromptSubmit");
    },
  );
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

describe("runPostToolUse", () => {
  /**
   * The same four failures as `runSessionStart`, and the matrix matters more
   * here than anywhere else: this hook fires after every edit, so a path that
   * throws once in a hundred calls throws several times an hour.
   */
  it.each([
    ["transport error", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["an API error", () => ({ error: { error: "Invalid API key." } })],
    // The API's real 404 body, as in the SessionStart table above.
    [
      "a cross-org or unknown project (404)",
      () => ({ error: { error: "Not found, or belongs to another org" } }),
    ],
    ["no data and no error", () => ({})],
    [
      "a body that is not a pack",
      () => ({ data: { nonsense: true } as unknown }),
    ],
  ])("does not block the edit on %s", async (_name, respond) => {
    const { client } = stubClient(respond as () => { data?: unknown });

    const outcome = await runPostToolUse(client, PROJECT, FILE, freshSession());

    expect(outcome.additionalContext).toBeNull();
    expect(outcome.tokens).toBe(0);
  });

  it("says nothing at all when no project is configured", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    const outcome = await runPostToolUse(
      client,
      undefined,
      FILE,
      freshSession(),
    );

    expect(outcome.additionalContext).toBeNull();
    expect(calls).toEqual([]);
  });

  it("says nothing at all when the payload carried no file path", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    const outcome = await runPostToolUse(
      client,
      PROJECT,
      undefined,
      freshSession(),
    );

    expect(outcome.additionalContext).toBeNull();
    expect(calls).toEqual([]);
  });

  /**
   * `PostToolUse` fires for every tool, and `hook-bin.ts` resolves a file path
   * only for the ones that change what a file says. A `Bash` or a `Read` never
   * reaches the network.
   */
  it("does not fire for a tool that did not edit anything", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    expect(EDIT_TOOLS.has("Bash")).toBe(false);
    expect(EDIT_TOOLS.has("Read")).toBe(false);
    expect(EDIT_TOOLS.has("Edit")).toBe(true);
    expect(EDIT_TOOLS.has("Write")).toBe(true);

    const outcome = await runPostToolUse(
      client,
      PROJECT,
      EDIT_TOOLS.has("Bash") ? FILE : undefined,
      freshSession(),
    );

    expect(outcome.additionalContext).toBeNull();
    expect(calls).toEqual([]);
  });

  it("asks with file scope, so the check reaches no model", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));

    await runPostToolUse(client, PROJECT, FILE, freshSession());

    expect(calls[0]?.body["scope"]).toBe("file");
    expect(calls[0]?.body["paths"]).toEqual([FILE]);
    expect(calls[0]?.body["budgetTokens"]).toBe(POST_TOOL_USE_BUDGET_TOKENS);
  });

  /**
   * `session_end` collapsed into `post_edit`: one check per file per session.
   * Without this, a file edited twenty times in a session is checked twenty
   * times, and the twentieth injection says exactly what the first one did.
   */
  it("checks a file once per session, however often it is edited", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));
    const session = freshSession();

    const first = await runPostToolUse(client, PROJECT, FILE, session);
    const second = await runPostToolUse(client, PROJECT, FILE, session);

    expect(first.additionalContext).toContain("packages/core is pure domain");
    expect(second.additionalContext).toBeNull();
    expect(second.diagnostic).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("still checks a different file in the same session", async () => {
    const { client, calls } = stubClient(() => ({ data: PACK }));
    const session = freshSession();

    await runPostToolUse(client, PROJECT, FILE, session);
    await runPostToolUse(client, PROJECT, "packages/api/src/app.ts", session);

    expect(calls).toHaveLength(2);
  });

  /**
   * The budget ordering is the whole argument for the number: this hook fires
   * more often than either of the others, and cost and noise kill the feature
   * by the same mechanism.
   */
  it("costs less than a mid-session nudge, because it fires far more often", () => {
    expect(POST_TOOL_USE_BUDGET_TOKENS).toBeLessThan(USER_PROMPT_BUDGET_TOKENS);
  });
});

describe("renderCheck", () => {
  /**
   * Without the id there is nothing to report a verdict against: `reconcile`
   * takes atom ids, and `renderPack` does not print them.
   */
  it("prints the id of every atom, so a verdict can name one", () => {
    const pack = {
      ...PACK,
      items: [
        ...PACK.items,
        {
          atomId: "33333333-3333-4333-8333-333333333333",
          statement: "Every migration is reversible.",
          kind: "convention",
          provenance: "CLAUDE.md#Code conventions",
        },
      ],
      total: 2,
      returned: 2,
    };

    const rendered = renderCheck(pack, FILE);

    for (const atom of pack.items) {
      expect(rendered).toContain(atom.atomId);
    }
  });

  it("asks for disproof, against the file that was edited", () => {
    const rendered = renderCheck(PACK, FILE);

    expect(rendered).toContain(FILE);
    expect(rendered).not.toContain("{path}");
    expect(rendered).toContain("Injected automatically");
  });
});

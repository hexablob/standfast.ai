import type { StandfastClient } from "@standfast/sdk";

/**
 * The push half of the delivery story.
 *
 * `docs/09-agent-contract.md` (*Pull versus push*): MCP is pull, and pull is
 * the wrong shape for cold start, because at cold start the agent does not know
 * there is anything to ask about. Whatever fraction of sessions get that right
 * is a property of the model of the month and moves with every release; a
 * product guarantee cannot rest on it. Hooks are deterministic and fire whether
 * or not the model wanted them.
 *
 * Three properties that document sets, and that the code below is arranged
 * around:
 *
 * 1. **Push never blocks.** Everything here fails open. `docs/14-roadmap.md`
 *    phase 2 exit criterion 7 asks for a test that a failing `SessionStart`
 *    hook does not block the session, and {@link runSessionStart} cannot throw
 *    — the transport error, the 401, the malformed payload and the timeout all
 *    land on the same path as "there is nothing to say".
 * 2. **What it injects is labelled as injected.** Pulled context was asked for;
 *    the agent chose the scope and the budget. Pushed context arrived
 *    unrequested. An agent should be able to tell the two apart, so the block
 *    below says where it came from and that nothing was asked for.
 * 3. **Push improves delivery; it never changes semantics.** Same tools, same
 *    envelope, same provenance, same fail-open behaviour. Every guarantee has
 *    to hold over MCP alone, because hooks exist on one client and a contract
 *    that holds only under hooks is a contract with one client's users.
 */

/**
 * What a pushed pack may cost, before the model has asked for anything.
 *
 * Deliberately below the `context` tool's own default. Pushed context is
 * conservative by default precisely because the agent chose neither its size
 * nor its moment (`docs/09-agent-contract.md`), and the cost is paid by every
 * session on the client whether or not the knowledge was wanted.
 *
 * `docs/08-mcp-server.md` requires this number to be recorded rather than
 * discovered, which is what `hooks.test.ts` asserts against.
 */
export const SESSION_START_BUDGET_TOKENS = 800;

/** The tighter budget for a mid-session nudge, which interrupts actual work. */
export const USER_PROMPT_BUDGET_TOKENS = 400;

/**
 * A rough token count for what this hook injects.
 *
 * **Deliberately not `tokenUpperBound` from `packages/core`**, and the reason
 * is a licence boundary rather than a technical one. `packages/core` is
 * AGPL-3.0-only; this package is Apache-2.0 because it ships to a user's
 * machine, and `packages/sdk` exists precisely so the CLI and the MCP server
 * have something to depend on without inheriting copyleft
 * (`docs/03-architecture.md`). Importing core here would quietly relicense the
 * MCP server.
 *
 * So this duplicates a few lines rather than sharing them, which is the right
 * trade exactly once and is written down so the next person does not "fix" it.
 * It is also allowed to be cruder: nothing gates on this number. It is
 * reported, so that the per-session cost of the push channel is a recorded
 * figure rather than one somebody has to discover
 * (`docs/08-mcp-server.md`) — the API's own budget is what actually bounds the
 * pack, and that one is enforced server side against a stricter bound.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type HookOutcome = {
  /** Markdown to inject, or null when there is nothing worth saying. */
  readonly additionalContext: string | null;
  /** One line for stderr, or null. Never more than one per invocation. */
  readonly diagnostic: string | null;
  /** The upper bound on what this injection costs. Zero when nothing is injected. */
  readonly tokens: number;
};

const NOTHING: HookOutcome = {
  additionalContext: null,
  diagnostic: null,
  tokens: 0,
};

type PackedAtom = {
  atomId: string;
  statement: string;
  kind: string;
  provenance: string;
};

type ContextResponse = {
  items: PackedAtom[];
  total: number;
  returned: number;
  truncated: boolean;
  budgetTokensUsed: number;
  skipped: string[];
};

/**
 * Renders a pack as the block an agent reads.
 *
 * Markdown rather than JSON because this is injected into a prompt rather than
 * returned from a tool, and a wall of braces spends budget on syntax. The tool
 * path still returns JSON — same content, different channel, which is the
 * distinction `docs/09-agent-contract.md` draws between improving delivery and
 * changing semantics.
 *
 * Provenance is on every line. `docs/02-principles.md` (13): a canonical atom
 * is a directive injected into every future session, and this is literally
 * that injection — so the reader is always told where each sentence came from
 * and can go and read it.
 */
export function renderPack(pack: ContextResponse, source: string): string {
  const lines = [
    `## Standfast — knowledge governing this project`,
    "",
    // Labelled as injected, per docs/09-agent-contract.md. An agent that cannot
    // tell what it asked for from what it was handed cannot reason about
    // either.
    `_Injected automatically by the Standfast ${source} hook. You did not request this._`,
    "",
  ];

  for (const atom of pack.items) {
    lines.push(
      `- **${atom.kind}** — ${atom.statement}  \n  ↳ ${atom.provenance}`,
    );
  }

  if (pack.truncated) {
    // The same contract as the envelope's flag, in prose. An agent that
    // believes it has seen everything reasons confidently and wrongly.
    lines.push(
      "",
      `_This is a partial view: ${pack.returned} of ${pack.total} candidates fitted the budget. Call the \`context\` tool with a larger \`budgetTokens\`, or \`search\`, for the rest._`,
    );
  }

  if (pack.skipped.length > 0) {
    // Visible degradation. Silent degradation would leave two ranking regimes
    // an evaluation cannot tell apart (docs/06-retrieval.md, condition 5).
    lines.push("", `_Retrieval stages skipped: ${pack.skipped.join(", ")}._`);
  }

  lines.push(
    "",
    "_These are ratified. Nothing here is a suggestion you may overrule silently; if the code must break one, say so._",
  );

  return lines.join("\n");
}

/**
 * Fetches a pack and renders it, or explains itself and returns nothing.
 *
 * **This function does not throw.** That is its contract, and every caller
 * depends on it: a hook that raises takes the session with it on some clients,
 * and `docs/09-agent-contract.md` resolves the whole failure table on the side
 * of proceeding on the agent's own judgment with one line of diagnostic.
 */
async function fetchPack(
  client: StandfastClient,
  input: {
    projectId: string;
    scope: "file" | "task" | "project";
    query?: string;
    paths?: string[];
    budgetTokens: number;
  },
  source: string,
): Promise<HookOutcome> {
  try {
    const { data, error } = await client.POST(
      "/v1/projects/{projectId}/context",
      {
        params: { path: { projectId: input.projectId } },
        body: {
          scope: input.scope,
          ...(input.query === undefined ? {} : { query: input.query }),
          paths: input.paths ?? [],
          budgetTokens: input.budgetTokens,
        },
      },
    );

    if (error || !data) {
      // One line, and it names the fix rather than the stack. Not a retry, not
      // a block, not a warning per call.
      return {
        ...NOTHING,
        diagnostic: `Standfast ${source}: no context this session (${describe(error)}). Proceeding without it.`,
      };
    }

    const pack = data as ContextResponse;

    // An empty pack is a valid answer and never worth an injection. A project
    // with no canonical atoms should cost a session nothing at all, and a
    // heading over an empty list would still cost tokens and still read as a
    // claim that there is nothing to know.
    if (pack.items.length === 0) return NOTHING;

    const rendered = renderPack(pack, source);
    return {
      additionalContext: rendered,
      diagnostic: null,
      // Measured on the rendered Markdown, not carried over from the API's
      // `budgetTokensUsed`, which counted a JSON envelope this never sends.
      tokens: approximateTokens(rendered),
    };
  } catch (cause) {
    return {
      ...NOTHING,
      diagnostic: `Standfast ${source}: unreachable (${describe(cause)}). Proceeding without it.`,
    };
  }
}

function describe(error: unknown): string {
  if (!error) return "no response";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "error" in error) {
    return String((error as { error: unknown }).error);
  }
  return String(error);
}

/**
 * `SessionStart` — the cold-start push.
 *
 * No query, because at session start there is nothing to describe yet. That
 * makes it `scope: "project"`, which runs generator 4 alone: a btree and a
 * sort, nothing to embed, nothing to rerank. The highest-frequency and most
 * latency-sensitive call in the system reaches no model at all, which is the
 * property `docs/06-retrieval.md` protects when the other generators are tuned.
 */
export async function runSessionStart(
  client: StandfastClient,
  projectId: string | undefined,
): Promise<HookOutcome> {
  // Not configured is not an error. A developer who has not linked this
  // repository to a project should see nothing, not a complaint on every
  // session.
  if (!projectId) return NOTHING;

  return fetchPack(
    client,
    {
      projectId,
      scope: "project",
      budgetTokens: SESSION_START_BUDGET_TOKENS,
    },
    "SessionStart",
  );
}

/**
 * `UserPromptSubmit` — the per-turn push.
 *
 * The prompt is the query, so this one does reach the retrieval model call.
 * Budgeted tighter than session start because it lands mid-work, and because
 * it fires on every turn rather than once.
 *
 * A very short prompt gets nothing: "ok", "continue" and "yes" carry no
 * retrievable intent, and embedding them would spend a model call and a slice
 * of budget to retrieve noise.
 */
export const MINIMUM_PROMPT_CHARS = 24;

export async function runUserPromptSubmit(
  client: StandfastClient,
  projectId: string | undefined,
  prompt: string,
): Promise<HookOutcome> {
  if (!projectId) return NOTHING;
  if (prompt.trim().length < MINIMUM_PROMPT_CHARS) return NOTHING;

  return fetchPack(
    client,
    {
      projectId,
      scope: "task",
      query: prompt,
      budgetTokens: USER_PROMPT_BUDGET_TOKENS,
    },
    "UserPromptSubmit",
  );
}

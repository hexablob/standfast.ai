import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StandfastClient } from "@standfast/sdk";
import { RECONCILE_PROMPT } from "./prompt.js";

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
 * The tightest budget of the three, because this hook fires after every edit.
 *
 * That makes it the highest-frequency injection Standfast has, and cost and
 * noise kill the feature by the same mechanism: nobody weighs the bill against
 * the nuisance, they turn the hook off. The user who does that is the one who
 * needed it — the sessions worth checking are the ones editing the most files.
 */
export const POST_TOOL_USE_BUDGET_TOKENS = 300;

/**
 * The tools that change what a file says.
 *
 * Lives here rather than inline in `hook-bin.ts` so the fact has one home and a
 * test can reach it. `Read`, `Grep` and `Bash` fire `PostToolUse` too, and
 * checking a file nobody touched spends budget to confirm the unchanged.
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write"]);

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

  lines.push(...caveats(pack));

  lines.push(
    "",
    "_These are ratified. Nothing here is a suggestion you may overrule silently; if the code must break one, say so._",
  );

  return lines.join("\n");
}

/**
 * What every rendering has to admit about the pack it is rendering.
 *
 * Shared by both renderers rather than written twice, because the two claims
 * are contracts and not decoration: an agent that believes it has seen
 * everything reasons confidently and wrongly, and silent degradation would
 * leave two ranking regimes an evaluation cannot tell apart
 * (`docs/06-retrieval.md`, condition 5).
 */
function caveats(pack: ContextResponse): string[] {
  const lines: string[] = [];

  if (pack.truncated) {
    lines.push(
      "",
      `_This is a partial view: ${pack.returned} of ${pack.total} candidates fitted the budget. Call the \`context\` tool with a larger \`budgetTokens\`, or \`search\`, for the rest._`,
    );
  }

  if (pack.skipped.length > 0) {
    lines.push("", `_Retrieval stages skipped: ${pack.skipped.join(", ")}._`);
  }

  return lines;
}

/**
 * Renders a pack as a question about one file rather than a briefing.
 *
 * Two differences from {@link renderPack}, and both are forced by what happens
 * next. The atom id is printed, because the agent cannot call `reconcile`
 * without one and `renderPack` does not print it — that renderer produces
 * something to read, this one produces something to answer. And the block ends
 * in {@link RECONCILE_PROMPT}, which asks for disproof rather than agreement:
 * an agent asked whether code honours a rule will say yes, so it is asked to
 * find the line that breaks it instead.
 */
export function renderCheck(pack: ContextResponse, filePath: string): string {
  const lines = [
    `## Standfast — check this edit against ratified knowledge`,
    "",
    // Labelled as injected, exactly as renderPack is (docs/09-agent-contract.md).
    `_Injected automatically by the Standfast PostToolUse hook. You did not request this._`,
    "",
  ];

  for (const atom of pack.items) {
    lines.push(
      `- **${atom.kind}** — ${atom.statement}  \n  ↳ ${atom.provenance}  \n  ↳ \`atomId\`: \`${atom.atomId}\``,
    );
  }

  lines.push(...caveats(pack));
  lines.push("", RECONCILE_PROMPT.replaceAll("{path}", filePath));

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
  // The one thing that varies between hooks. Everything else here — the
  // never-throws contract, the empty-pack rule, the diagnostic — is identical
  // across all three, and duplicating it per hook would mean three fail-open
  // paths to keep true instead of one.
  render: (pack: ContextResponse, source: string) => string = renderPack,
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

    const rendered = render(pack, source);
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

/**
 * `PostToolUse` — the check after an edit.
 *
 * This is `session_end` collapsed into `post_edit`: one check per file per
 * session, at the moment the agent still has the change in front of it, rather
 * than a sweep at the end when the context that produced the edit is gone.
 *
 * A `Stop` hook is deliberately **not** built. To be useful a Stop hook has to
 * block the stop — inject, then get an answer — and hooks never block
 * (`docs/09-agent-contract.md`). One that injects without blocking writes into
 * a turn nobody will take, which costs tokens to say nothing.
 *
 * `scope: "file"` reaches no model on the server: paths resolve through
 * generators 1 and 4, so the highest-frequency hook is also the cheapest one
 * (`docs/06-retrieval.md`).
 */
export async function runPostToolUse(
  client: StandfastClient,
  projectId: string | undefined,
  filePath: string | undefined,
  sessionId: string,
): Promise<HookOutcome> {
  // Not linked, not an edit, or an edit this session already checked. Each is
  // silence rather than a diagnostic: a hook this frequent that complains once
  // per edit is a hook that gets removed from the settings file.
  if (!projectId || !filePath) return NOTHING;
  if (alreadyChecked(sessionId, filePath)) return NOTHING;

  const outcome = await fetchPack(
    client,
    {
      projectId,
      scope: "file",
      paths: [filePath],
      budgetTokens: POST_TOOL_USE_BUDGET_TOKENS,
    },
    "PostToolUse",
    (pack) => renderCheck(pack, filePath),
  );

  // Recorded when the server answered, injection or not. A file with nothing
  // governing it is the common case, and re-asking after every edit to it would
  // put a request on the wire per keystroke-sized change forever. A failed call
  // records nothing, because the failure may be the network rather than the
  // answer.
  if (!outcome.diagnostic) recordChecked(sessionId, filePath);

  return outcome;
}

/**
 * The one-check-per-file-per-session ledger.
 *
 * A file in the temporary directory rather than memory, because each hook
 * invocation is its own process and there is nothing to hold state in between.
 * Nothing here is authoritative: losing it means one extra check, which is why
 * every path swallows its error rather than reporting one.
 */
function sessionLedger(sessionId: string): string {
  // The session id arrives in the hook payload, which is not this package's to
  // trust. Anything outside the allowed set is dropped rather than escaped, so
  // no value of it can name a path outside the temporary directory. An id that
  // reduces to nothing shares one ledger with every other such session, which
  // over-deduplicates — the quiet failure, not the noisy one.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return join(tmpdir(), `standfast-hook-${safe}.txt`);
}

function alreadyChecked(sessionId: string, filePath: string): boolean {
  try {
    const seen = readFileSync(sessionLedger(sessionId), "utf8").split("\n");
    return seen.includes(filePath);
  } catch {
    // No ledger yet, or an unreadable one. Both mean "go ahead": failing toward
    // one redundant check is cheaper than failing toward never checking again.
    return false;
  }
}

function recordChecked(sessionId: string, filePath: string): void {
  try {
    appendFileSync(sessionLedger(sessionId), `${filePath}\n`);
  } catch {
    // Deliberately empty. A ledger that cannot be written costs a duplicate
    // injection; a hook that throws costs the session.
  }
}

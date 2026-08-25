#!/usr/bin/env node
/**
 * The Standfast hooks, for clients that have them.
 *
 *   standfast-hook SessionStart
 *   standfast-hook UserPromptSubmit
 *   standfast-hook PostToolUse
 *
 * Configured in a Claude Code settings file, for example:
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [{ "type": "command", "command": "standfast-hook SessionStart" }] }
 *       ]
 *     }
 *   }
 *
 * Reads the client's hook payload as JSON on stdin, writes a hook result as
 * JSON on stdout, and puts every diagnostic on stderr.
 *
 * **It exits 0. Always.** `docs/09-agent-contract.md` resolves the entire
 * failure table on the side of proceeding on the agent's own judgment, and
 * `docs/14-roadmap.md` phase 2 exit criterion 7 asks for a test that a failing
 * `SessionStart` hook does not block the session. A non-zero exit here is a
 * developer whose session will not start because a knowledge layer was having a
 * bad afternoon — which would make Standfast a liability at exactly the moment it
 * is least useful.
 *
 * `docs/08-mcp-server.md` records the distribution consequence: hooks and the
 * MCP server ship together as a Claude Code plugin, because configuring one
 * without the other gives an agent tools with no cold start, or a cold start
 * with no way to follow up.
 */
import { createClient, type StandfastClient } from "@standfast/sdk";
import {
  EDIT_TOOLS,
  type HookOutcome,
  runPostToolUse,
  runSessionStart,
  runUserPromptSubmit,
} from "./hooks.js";

/** Emitted whenever there is nothing to say. Valid output, zero cost. */
const SILENT: HookOutcome = {
  additionalContext: null,
  diagnostic: null,
  tokens: 0,
};

/** Everything below is wrapped so that no path reaches a non-zero exit. */
async function main(): Promise<void> {
  const event = process.argv[2] ?? "SessionStart";

  const payload = await readPayload();
  const apiKey = process.env["STANDFAST_API_KEY"];
  const baseUrl = process.env["STANDFAST_BASE_URL"] ?? "http://localhost:8080";

  // The project this repository is linked to. Read from the environment rather
  // than discovered, because discovery would mean a call before the call, and
  // the cold-start path is the one with a latency budget nobody is watching.
  const projectId = process.env["STANDFAST_PROJECT_ID"];

  if (!apiKey) {
    // Not configured is not a failure, and must not be noisy: a developer who
    // has not set Standfast up should not see a complaint on every session.
    emit(event, SILENT);
    return;
  }

  const client = createClient({ apiKey, baseUrl });

  // Explicit, and not a ternary with a default. The default used to be
  // `runSessionStart`, which meant every event this build did not recognise
  // pushed the whole project pack — so adding `PostToolUse` to a settings file
  // would have injected the entire project after every single edit, at session
  // start's budget, forever. An unknown event now does nothing at all.
  const outcome = await run(event, client, projectId, payload);

  emit(event, outcome);
}

async function run(
  event: string,
  client: StandfastClient,
  projectId: string | undefined,
  payload: Record<string, unknown>,
): Promise<HookOutcome> {
  switch (event) {
    case "SessionStart":
      return runSessionStart(client, projectId);
    case "UserPromptSubmit":
      return runUserPromptSubmit(client, projectId, promptOf(payload));
    case "PostToolUse":
      // `PostToolUse` fires for every tool. Only an edit changes what the file
      // says, and checking a file nobody wrote is budget spent to confirm the
      // unchanged.
      return EDIT_TOOLS.has(stringAt(payload, "tool_name"))
        ? runPostToolUse(
            client,
            projectId,
            filePathOf(payload),
            stringAt(payload, "session_id"),
          )
        : SILENT;
    default:
      return SILENT;
  }
}

/**
 * Reads stdin to the end, tolerating an empty or malformed body.
 *
 * A client that sends nothing, or sends something this version does not
 * understand, gets the same treatment as any other failure: the hook still
 * runs, still emits valid output, and still exits 0.
 */
async function readPayload(): Promise<Record<string, unknown>> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function promptOf(payload: Record<string, unknown>): string {
  return stringAt(payload, "prompt");
}

function stringAt(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/**
 * The path the agent just edited.
 *
 * `undefined` rather than `""` when it is missing, because that is what
 * {@link runPostToolUse} treats as "nothing to check" — a client that shapes
 * `tool_input` differently, or a version that renames the field, gets silence
 * rather than a check of the empty path.
 */
function filePathOf(payload: Record<string, unknown>): string | undefined {
  const input = payload["tool_input"];
  if (typeof input !== "object" || input === null) return undefined;

  const filePath = (input as Record<string, unknown>)["file_path"];
  return typeof filePath === "string" && filePath ? filePath : undefined;
}

/**
 * Writes the hook result.
 *
 * `additionalContext` is the field the client injects. Omitted entirely when
 * there is nothing to say — an empty string would still be a turn's worth of
 * structure around nothing.
 */
function emit(event: string, outcome: HookOutcome): void {
  if (outcome.diagnostic) {
    // stderr, and once. stdout carries the result, so a stray write there
    // corrupts it and the client sees a hook that failed for no visible reason
    // — the same rule bin.ts follows for the protocol stream.
    process.stderr.write(`${outcome.diagnostic}\n`);
  }

  const result: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: event,
      ...(outcome.additionalContext
        ? { additionalContext: outcome.additionalContext }
        : {}),
    },
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((cause: unknown) => {
    // The last line of defence. Anything that got past the fail-open paths
    // inside `hooks.ts` lands here, and still does not take the session with
    // it.
    process.stderr.write(
      `Standfast hook: ${cause instanceof Error ? cause.message : String(cause)}. Proceeding without it.\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: process.argv[2] ?? "SessionStart" } })}\n`,
    );
  })
  .finally(() => {
    process.exit(0);
  });

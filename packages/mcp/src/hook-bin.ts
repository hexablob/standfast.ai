#!/usr/bin/env node
/**
 * The Standfast hooks, for clients that have them.
 *
 *   standfast-hook SessionStart
 *   standfast-hook UserPromptSubmit
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
import { createClient } from "@standfast/sdk";
import {
  type HookOutcome,
  runSessionStart,
  runUserPromptSubmit,
} from "./hooks.js";

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
    emit(event, { additionalContext: null, diagnostic: null, tokens: 0 });
    return;
  }

  const client = createClient({ apiKey, baseUrl });

  const outcome =
    event === "UserPromptSubmit"
      ? await runUserPromptSubmit(client, projectId, promptOf(payload))
      : await runSessionStart(client, projectId);

  emit(event, outcome);
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
  const prompt = payload["prompt"];
  return typeof prompt === "string" ? prompt : "";
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

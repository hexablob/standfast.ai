import { parseArgs } from "node:util";
import { createClient } from "@standfast/sdk";
import type { Ctx } from "./commands.js";
import * as commands from "./commands.js";
import { DEFAULT_BASE_URL, loadConfig } from "./config.js";
import { exportAll } from "./export.js";
import { type Format, note, UsageError } from "./output.js";
import { syncResolve, syncRun, syncStatus } from "./sync.js";

/**
 * Argument parsing uses `node:util` `parseArgs`. It is a runtime builtin, so
 * the CLI still declares exactly one dependency: the SDK. `CLAUDE.md` asks for
 * a new dependency to be justified, and "commander is nicer" is not a
 * justification at this size.
 */

/** Exported so a test can hold it against OPTIONS — see cli.test.ts. */
export const USAGE = `standfast — a shared knowledge layer for coding agents

  standfast login --key <sf_sk_…> [--url <base-url>]
  standfast logout
  standfast whoami

  standfast project ls [--limit <n>] [--offset <n>]
  standfast project create <name> [--slug <slug>]

  standfast doc ls    --project <id> [--limit <n>] [--offset <n>]
  standfast doc push  <file.md…> --project <id> [--path <stored-name>]
  standfast doc rm    <document-id>              the explicit delete; sync never deletes

  standfast sync [dir] [--accept]                one-shot folder → server sync (standfast.sync.json)
  standfast sync status [dir]                    print the plan, change nothing
  standfast sync resolve <path> --take-local | --take-remote [dir]

  standfast atom ls   --project <id> [--limit <n>] [--offset <n>]

  standfast queue     --project <id> [--kind <kind>] [--document <id>] [--limit <n>] [--offset <n>]
  standfast next      --project <id> [--kind <kind>] [--document <id>] [--skip <n>]
  standfast ratify    <atom-id> [--supersedes <atom-id>]
  standfast reject    <atom-id> [--reason <reason>] [--note <text>]
  standfast retire    <atom-id>
  standfast ratification --project <id> --older-than <7d|36h|90m|900s|seconds>

  standfast findings ls      --project <id> [--status <state>] [--limit <n>] [--offset <n>]
  standfast findings resolve <finding-id> --accept | --dismiss

  standfast egress    --project <id> [--events [--limit <n>] [--offset <n>]]

  standfast export [directory]        full Markdown export, yours to keep

Options
  --json          machine-readable output on stdout
  --url           override the base URL for this invocation
  -h, --help      this
  -v, --version   version

Environment
  STANDFAST_API_KEY, STANDFAST_BASE_URL override the stored credential.
`;

type Handler = (ctx: Ctx) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  login: commands.login,
  logout: commands.logout,
  whoami: commands.whoami,
  "project ls": commands.projectList,
  "project list": commands.projectList,
  "project create": commands.projectCreate,
  "doc ls": commands.documentList,
  "doc list": commands.documentList,
  "doc push": commands.documentPush,
  "doc rm": commands.documentRemove,
  sync: syncRun,
  "sync status": syncStatus,
  "sync resolve": syncResolve,
  "atom ls": commands.atomList,
  queue: commands.queueList,
  next: commands.queueNext,
  ratify: commands.atomRatify,
  reject: commands.atomReject,
  retire: commands.atomRetire,
  ratification: commands.ratification,
  egress: commands.egressList,
  "atom list": commands.atomList,
  "findings ls": commands.findingsList,
  "findings list": commands.findingsList,
  "findings resolve": commands.findingsResolve,
  export: exportAll,
};

export type RunDeps = {
  /** Injected by tests so commands can be driven without a socket. */
  fetch?: typeof globalThis.fetch;
};

/**
 * Exported for the test that reconciles this map against the flags the
 * commands actually read. `parseArgs` is strict, so a flag read by a command
 * but missing here does not degrade — it rejects the whole invocation before
 * the command runs, and the documented flag becomes unusable. That is silent
 * until somebody types it, which is exactly the kind of gap a test should
 * hold shut.
 */
export const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  key: { type: "string" },
  url: { type: "string" },
  slug: { type: "string" },
  project: { type: "string" },
  path: { type: "string" },
  status: { type: "string" },
  kind: { type: "string" },
  document: { type: "string" },
  supersedes: { type: "string" },
  reason: { type: "string" },
  note: { type: "string" },
  // Hyphenated, so it reaches `commands.ts` as `ctx.flags["older-than"]`. It
  // deliberately has no default — see `commands.ts` `ratification`.
  "older-than": { type: "string" },
  accept: { type: "boolean" },
  dismiss: { type: "boolean" },
  events: { type: "boolean" },
  // The two answers `sync resolve` accepts; exactly one must be passed.
  "take-local": { type: "boolean" },
  "take-remote": { type: "boolean" },
  // Counts, but `parseArgs` has no numeric type: it hands back the raw string,
  // and `pageQuery` in commands.ts is the single place that turns either into
  // a number and refuses it if it is not one.
  limit: { type: "string" },
  offset: { type: "string" },
  // `next` only. A count like the two above, validated the same way in
  // commands.ts; it rides the queue route's `offset` so nothing is persisted.
  skip: { type: "string" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  let parsed: ReturnType<typeof parse>;

  try {
    parsed = parse(argv);
  } catch (error) {
    note(error instanceof Error ? error.message : String(error));
    note(USAGE);
    return 2;
  }

  const flags = parsed.values as Ctx["flags"];
  const positionals = parsed.positionals;

  if (flags["version"]) {
    process.stdout.write("0.0.0\n");
    return 0;
  }
  if (flags["help"] || positionals.length === 0) {
    process.stdout.write(USAGE);
    return positionals.length === 0 && !flags["help"] ? 2 : 0;
  }

  // Two-word commands first, so `project ls` wins over a bare `project`.
  const two = positionals.slice(0, 2).join(" ");
  const one = positionals[0] ?? "";
  const route = ROUTES[two] ?? ROUTES[one];
  if (!route) {
    note(`Unknown command: ${positionals.join(" ")}`);
    note(USAGE);
    return 2;
  }
  const consumed = ROUTES[two] ? 2 : 1;

  const config = await loadConfig();
  const baseUrl =
    (typeof flags["url"] === "string" ? flags["url"] : undefined) ??
    config.baseUrl ??
    DEFAULT_BASE_URL;

  const ctx: Ctx = {
    config: { ...config, baseUrl },
    format: (flags["json"] ? "json" : "text") as Format,
    flags,
    args: positionals.slice(consumed),
    client: () => {
      if (!config.apiKey) {
        throw new UsageError(
          "Not logged in. Run: standfast login --key <sf_sk_…>",
        );
      }
      return createClient({
        baseUrl,
        apiKey: config.apiKey,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    },
  };

  try {
    await route(ctx);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      note(error.message);
      return 2;
    }
    note(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

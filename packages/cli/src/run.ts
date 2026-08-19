import { parseArgs } from "node:util";
import { createClient } from "@standfast/sdk";
import type { Ctx } from "./commands.js";
import * as commands from "./commands.js";
import { DEFAULT_BASE_URL, loadConfig } from "./config.js";
import { type Format, note, UsageError } from "./output.js";

/**
 * Argument parsing uses `node:util` `parseArgs`. It is a runtime builtin, so
 * the CLI still declares exactly one dependency: the SDK. `CLAUDE.md` asks for
 * a new dependency to be justified, and "commander is nicer" is not a
 * justification at this size.
 */

const USAGE = `standfast — a shared knowledge layer for coding agents

  standfast login --key <sf_sk_…> [--url <base-url>]
  standfast logout
  standfast whoami

  standfast project ls
  standfast project create <name> [--slug <slug>]

  standfast doc ls    --project <id>
  standfast doc push  <file.md…> --project <id> [--path <stored-name>]

  standfast atom ls   --project <id>

  standfast egress    --project <id> [--events] [--limit <n>]

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
  "atom ls": commands.atomList,
  egress: commands.egressList,
  "atom list": commands.atomList,
  export: commands.exportAll,
};

export type RunDeps = {
  /** Injected by tests so commands can be driven without a socket. */
  fetch?: typeof globalThis.fetch;
};

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  key: { type: "string" },
  url: { type: "string" },
  slug: { type: "string" },
  project: { type: "string" },
  path: { type: "string" },
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

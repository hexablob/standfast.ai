import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { StandfastClient } from "@standfast/sdk";
import {
  type Config,
  clearConfig,
  configPath,
  redactKey,
  saveConfig,
} from "./config.js";
import { type Format, note, out, table, UsageError } from "./output.js";

export type Ctx = {
  client: () => StandfastClient;
  config: Partial<Config>;
  format: Format;
  flags: Record<string, string | boolean | undefined>;
  args: string[];
};

/** openapi-fetch returns errors rather than throwing; turn them into one. */
function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.data === undefined) {
    const detail =
      (result.error as { error?: string } | undefined)?.error ??
      result.response.statusText;
    throw new Error(`${result.response.status} ${detail}`);
  }
  return result.data;
}

/**
 * Walks every page of a list endpoint and returns the lot.
 *
 * For the commands where a partial answer is a wrong answer. `export` is the
 * one that matters: `docs/02-principles.md` (11) makes full Markdown export the
 * anti-lock-in guarantee, and an export that silently stopped at the first
 * fifty documents would be a guarantee that quietly is not one — which is worse
 * than not offering it. `docs/14-roadmap.md` names git export as one of the
 * three places that needed pagination.
 *
 * Asks for the largest page the API allows, so a big project is a handful of
 * round trips rather than a hundred. Stops on `truncated`, which the query
 * computed, rather than on a short page — a full page that happens to be the
 * last one is not a signal, and an empty page guards against a server that
 * disagrees.
 */
async function pageAll<T>(
  fetchPage: (page: {
    limit: number;
    offset: number;
  }) => Promise<{ items: T[]; truncated: boolean }>,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  for (;;) {
    const page = await fetchPage({ limit: 200, offset });
    all.push(...page.items);
    if (!page.truncated || page.items.length === 0) return all;
    offset += page.items.length;
  }
}

/** Appended to a listing that showed one page of a longer set. */
function moreThanShown(page: {
  total: number;
  returned: number;
  truncated: boolean;
}): string {
  return page.truncated
    ? `\n\nShowing ${page.returned} of ${page.total}. Use --limit and --offset for the rest.`
    : "";
}

export async function login(ctx: Ctx): Promise<void> {
  const apiKey = String(ctx.flags["key"] ?? "");
  const baseUrl = String(
    ctx.flags["url"] ?? ctx.config.baseUrl ?? "http://localhost:8080",
  );
  if (!apiKey) {
    throw new UsageError("standfast login --key <sf_sk_…> [--url <base-url>]");
  }

  await saveConfig({ apiKey, baseUrl });
  note(`Saved to ${configPath()} (mode 600).`);
  out(ctx.format, `Logged in to ${baseUrl} as ${redactKey(apiKey)}`, {
    baseUrl,
    key: redactKey(apiKey),
  });
}

export async function logout(ctx: Ctx): Promise<void> {
  await clearConfig();
  out(ctx.format, "Credentials removed.", { removed: true });
}

/**
 * Verifies the credential against the server rather than reporting what is on
 * disk. "Logged in" that has never been checked is not information.
 */
export async function whoami(ctx: Ctx): Promise<void> {
  // `total` rather than a page length: the question is how many projects the
  // key can see, and one page of them is not an answer to it.
  const page = unwrap(await ctx.client().GET("/v1/projects"));
  out(
    ctx.format,
    `Key valid for ${ctx.config.baseUrl}. ${page.total} project(s) visible.`,
    { baseUrl: ctx.config.baseUrl, projects: page.total },
  );
}

export async function projectList(ctx: Ctx): Promise<void> {
  const page = unwrap(await ctx.client().GET("/v1/projects"));
  out(
    ctx.format,
    page.items.length === 0
      ? "No projects yet."
      : table([
          ["SLUG", "NAME", "ID"],
          ...page.items.map((p) => [p.slug, p.name, p.id]),
        ]) + moreThanShown(page),
    page,
  );
}

export async function projectCreate(ctx: Ctx): Promise<void> {
  const name = ctx.args[0];
  if (!name) {
    throw new UsageError("standfast project create <name> [--slug <slug>]");
  }
  const slug =
    String(ctx.flags["slug"] ?? "") ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const project = unwrap(
    await ctx.client().POST("/v1/projects", { body: { name, slug } }),
  );
  out(ctx.format, `Created ${project.slug}  ${project.id}`, project);
}

export async function documentList(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  const docs = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/documents", {
      params: { path: { projectId } },
    }),
  );
  out(
    ctx.format,
    docs.items.length === 0
      ? "No documents."
      : table([["PATH", "ID"], ...docs.items.map((d) => [d.path, d.id])]) +
          moreThanShown(docs),
    docs,
  );
}

/**
 * The path a document is stored under: relative to the working directory,
 * with forward slashes.
 *
 * Never the absolute local path. That would ship the operator's filesystem
 * layout — home directory and username included — to the server, tie the
 * document to one machine, and leave `standfast export` unable to reconstruct
 * anything, since an absolute path cannot be written inside an export
 * directory.
 */
export function storagePath(file: string, override?: string): string {
  if (override) {
    return override.split(sep).join("/").replace(/^\.\//, "");
  }
  const rel = relative(process.cwd(), resolve(file));
  if (rel.startsWith("..") || rel === "") {
    throw new UsageError(
      `${file} is outside the current directory. Pass --path <name> to say how it should be stored.`,
    );
  }
  return rel.split(sep).join("/");
}

/**
 * Pushes local Markdown. The stored path keeps the repository's own layout,
 * so `standfast export` reproduces it.
 */
export async function documentPush(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  if (ctx.args.length === 0) {
    throw new UsageError("standfast doc push <file.md…> --project <id>");
  }

  const override =
    typeof ctx.flags["path"] === "string" ? ctx.flags["path"] : undefined;
  if (override && ctx.args.length > 1) {
    throw new UsageError(
      "--path names a single document; push one file at a time.",
    );
  }

  const pushed: { path: string; id: string }[] = [];
  for (const file of ctx.args) {
    const body = await readFile(file, "utf8");
    const stored = storagePath(file, override);
    const doc = unwrap(
      await ctx.client().PUT("/v1/projects/{projectId}/documents", {
        params: { path: { projectId } },
        body: { path: stored, title: basename(stored), body },
      }),
    );
    pushed.push({ path: doc.path, id: doc.id });
  }

  out(ctx.format, pushed.map((p) => `pushed ${p.path}`).join("\n"), pushed);
}

export async function atomList(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  const atoms = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/atoms", {
      params: { path: { projectId } },
    }),
  );
  out(
    ctx.format,
    atoms.items.length === 0
      ? "No atoms."
      : table([
          ["STATUS", "KIND", "STATEMENT", "ID"],
          ...atoms.items.map((a) => [
            a.status,
            a.kind,
            a.statement.slice(0, 60),
            a.id,
          ]),
        ]) + moreThanShown(atoms),
    atoms,
  );
}

/**
 * Full Markdown export to a directory the customer controls.
 *
 * `docs/02-principles.md` (11): anti-lock-in is a feature. It removes a
 * purchase objection for very little engineering, and it is only credible if
 * it exists before anyone asks.
 */
export async function exportAll(ctx: Ctx): Promise<void> {
  const target = resolve(ctx.args[0] ?? "standfast-export");
  const client = ctx.client();
  const projects = await pageAll(async (query) =>
    unwrap(await client.GET("/v1/projects", { params: { query } })),
  );

  let written = 0;
  for (const project of projects) {
    const docs = await pageAll(async (query) =>
      unwrap(
        await client.GET("/v1/projects/{projectId}/documents", {
          params: { path: { projectId: project.id }, query },
        }),
      ),
    );
    for (const doc of docs) {
      const destination = safeJoin(join(target, project.slug), doc.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, doc.body, "utf8");
      written += 1;
    }
  }

  out(ctx.format, `Exported ${written} document(s) to ${target}`, {
    target,
    written,
  });
}

/**
 * Joins a server-supplied path under a base directory, refusing anything that
 * escapes it.
 *
 * `doc.path` comes from the API. Writing it to disk unchecked would let
 * `../../.ssh/authorized_keys` out of a compromised or merely buggy server —
 * a server should not be able to choose where a client writes.
 */
export function safeJoin(base: string, candidate: string): string {
  const baseResolved = resolve(base);
  const joined = resolve(baseResolved, candidate);
  const rel = relative(baseResolved, joined);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
    throw new Error(
      `Refusing to write outside the export directory: ${candidate}`,
    );
  }
  return joined;
}

async function requireProject(ctx: Ctx): Promise<string> {
  const explicit = ctx.flags["project"];
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  throw new UsageError(
    "--project <id> is required (see: standfast project ls)",
  );
}

/**
 * What this project has sent to a provider.
 *
 * `docs/13-threat-model.md` (*Egress*, rule 3) says a customer can ask what
 * left, to which provider, for which project, and that an answer requiring
 * somebody to read code is not good enough. A SQL prompt is barely better.
 * This is the command that makes the question ordinary.
 *
 * Prints nothing but sizes. There is no flag that shows what was sent, because
 * the record does not hold it.
 */
export async function egressList(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);

  if (ctx.flags["events"]) {
    const limit = ctx.flags["limit"];
    const events = unwrap(
      await ctx.client().GET("/v1/projects/{projectId}/egress/events", {
        params: {
          path: { projectId },
          query: limit ? { limit: Number(limit) } : {},
        },
      }),
    );
    out(
      ctx.format,
      events.items.length === 0
        ? "Nothing has left this project."
        : table([
            ["AT", "PURPOSE", "DESTINATION", "MODEL", "ITEMS", "CHARS"],
            ...events.items.map((e) => [
              e.at,
              e.purpose,
              e.destination,
              e.model,
              String(e.inputItems),
              String(e.inputChars),
            ]),
          ]) + moreThanShown(events),
      events,
    );
    return;
  }

  const summary = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/egress", {
      params: { path: { projectId } },
    }),
  );
  out(
    ctx.format,
    summary.length === 0
      ? // Said plainly, because it is the answer a self-hosted deployment on
        // local models should get, and it should not read like an empty table.
        "Nothing has left this project."
      : table([
          ["PURPOSE", "DESTINATION", "MODEL", "CALLS", "ITEMS", "CHARS"],
          ...summary.map((s) => [
            s.purpose,
            s.destination,
            s.model,
            String(s.calls),
            String(s.items),
            String(s.chars),
          ]),
        ]),
    summary,
  );
}

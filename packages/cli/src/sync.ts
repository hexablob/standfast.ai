import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { type Ctx, pageAll, unwrap } from "./commands.js";
import { configDir } from "./config.js";
import { out, UsageError } from "./output.js";
import { type Operation, plan, scopeDigest } from "./sync-plan.js";

/**
 * `standfast sync` — the impure half: `docs/10-sync-daemon.md` as a CLI
 * one-shot. Folder → server, never the reverse; the allowlist gates the read;
 * absence never deletes.
 */

/**
 * The config file is `standfast.sync.json`, not `standfast.json` — that name
 * is already the export manifest's, and `standfast export` treats a directory
 * holding one as its own to sweep. One file serving two features is how a
 * sync scope gets mistaken for an ownership sentinel.
 */
const SYNC_CONFIG = "standfast.sync.json";

export type SyncConfig = {
  /** Exactly one project, by slug or id. One folder, one project. */
  project: string;
  /** Include-only globs. There is no `exclude`, by design (docs/10). */
  include: string[];
};

/**
 * Refuses anything but exactly `{ project, include }`. An unknown key is not
 * ignored, because the likeliest unknown key is `exclude`, and a denylist
 * silently ignored is worse than one refused with the reason.
 */
export function parseSyncConfig(raw: string, where: string): SyncConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${where} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`${where} must be a JSON object.`);
  }
  const unknown = Object.keys(parsed).filter(
    (key) => key !== "project" && key !== "include",
  );
  if (unknown.length > 0) {
    throw new UsageError(
      `${where} has keys it does not define: ${unknown.join(", ")}. ` +
        `It accepts exactly "project" and "include" — there is no "exclude", by design (docs/10-sync-daemon.md).`,
    );
  }
  const { project, include } = parsed as Partial<SyncConfig>;
  if (typeof project !== "string" || project === "") {
    throw new UsageError(
      `${where} needs "project": a slug or id, exactly one.`,
    );
  }
  if (
    !Array.isArray(include) ||
    include.length === 0 ||
    include.some((glob) => typeof glob !== "string" || glob === "")
  ) {
    throw new UsageError(
      `${where} needs "include": a non-empty list of globs.`,
    );
  }
  return { project, include };
}

/**
 * A deliberate re-derivation of the server's content hash, not an import. The
 * definition lives in `packages/core`, which is AGPL-3.0-only; this CLI is
 * Apache-2.0 and may import only `@standfast/sdk`. The two implementations
 * are held to one answer by the cross-boundary vector test in `packages/api`
 * (which may depend on both); if `contentHash` ever gains normalisation, the
 * definition moves rather than being copied a third time.
 */
export function localContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The filesystem the walk sees, injected so a test can hand in a stub that
 * throws on any read outside the allowlist — proving structurally that only
 * matched paths are ever read, rather than trusting a filter.
 */
export type SyncDirent = {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export type SyncFs = {
  readdir(dir: string): Promise<SyncDirent[]>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
};

const realFs: SyncFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
};

/**
 * Walks the sync root and reads the matched files, and only those.
 *
 * The allowlist gates the read (docs/10): enumeration touches names, and
 * `fs.readFile` is reached by matched paths and nothing else — a bug in
 * hashing or upload cannot leak content the process never held. Symlinks are
 * not followed, and a path that resolves outside the root is refused — the
 * same rule `storagePath` and `safeJoin` already enforce elsewhere.
 *
 * A matched file that cannot be read throws, and the run exits 1: a partial
 * sync that skipped a file silently would be drift wearing a green exit code.
 */
export async function gatherLocal(
  root: string,
  include: readonly string[],
  fs: SyncFs,
): Promise<{
  paths: string[];
  files: Map<string, { hash: string; body: string }>;
}> {
  const walked: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir)) {
      if (entry.isSymbolicLink()) {
        continue; // Never followed: a symlink is a path escape with extra steps.
      }
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (rel === "" || rel.startsWith("..")) {
        throw new Error(`Refusing to leave the sync root: ${full}`);
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        walked.push(rel);
      }
    }
  };
  await walk(root);

  const paths = walked
    .filter((rel) => include.some((glob) => matchesGlob(rel, glob)))
    .sort();

  const files = new Map<string, { hash: string; body: string }>();
  for (const path of paths) {
    const body = await fs.readFile(join(root, path.split("/").join(sep)));
    files.set(path, { hash: localContentHash(body), body });
  }
  return { paths, files };
}

/**
 * Per-clone state, keyed by the folder's realpath:
 * `~/.config/standfast/sync/<sha256(realpath)[0:16]>.json`.
 *
 * Deliberately not in the repository — the base records what *this clone*
 * last synced, and two developers sharing a base through git would each
 * inherit the other's uploads as their own. And deliberately not inside the
 * credential file: `standfast logout` removes that, and losing a credential
 * must not also lose every sync base on the machine.
 */
export function journalPath(realRoot: string): string {
  const key = createHash("sha256")
    .update(realRoot, "utf8")
    .digest("hex")
    .slice(0, 16);
  return join(configDir(), "sync", `${key}.json`);
}

type Journal = {
  project: string;
  scopeDigest: string;
  base: Record<string, string>;
  unseen: string[];
};

async function loadJournal(path: string): Promise<Journal | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Journal;
  } catch {
    return null; // No journal yet is the normal state before the first sync.
  }
}

async function saveJournal(path: string, journal: Journal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveProjectId(ctx: Ctx, project: string): Promise<string> {
  if (UUID.test(project)) {
    return project;
  }
  const projects = await pageAll(async (query) =>
    unwrap(await ctx.client().GET("/v1/projects", { params: { query } })),
  );
  const hit = projects.find((p) => p.slug === project);
  if (!hit) {
    throw new Error(
      `No project with slug ${project} is visible to this key (see: standfast project ls).`,
    );
  }
  return hit.id;
}

type Prepared = {
  root: string;
  journalFile: string;
  config: SyncConfig;
  projectId: string;
  matched: string[];
  files: Map<string, { hash: string; body: string }>;
  digest: string;
  journal: Journal | null;
  base: Record<string, string>;
  armed: boolean;
  remote: Record<string, string>;
  operations: Operation[];
};

/** Everything both `sync` and its subcommands need, gathered once. */
async function prepare(
  ctx: Ctx,
  fs: SyncFs,
  dir: string | undefined,
): Promise<Prepared> {
  const root = resolve(dir ?? ".");
  let raw: string;
  try {
    raw = await fs.readFile(join(root, SYNC_CONFIG));
  } catch {
    throw new UsageError(
      `No ${SYNC_CONFIG} in ${root}. It names one project and the include-only globs; see docs/10-sync-daemon.md.`,
    );
  }
  const config = parseSyncConfig(raw, join(root, SYNC_CONFIG));
  const journalFile = journalPath(await fs.realpath(root));
  const journal = await loadJournal(journalFile);

  const { paths: matched, files } = await gatherLocal(root, config.include, fs);
  const digest = scopeDigest(matched);

  // A journal written for another project describes other documents; its
  // bases are meaningless here and a stale one must not arm the run.
  const base =
    journal !== null && journal.project === config.project ? journal.base : {};
  const armed =
    journal !== null &&
    journal.project === config.project &&
    journal.scopeDigest === digest;

  const projectId = await resolveProjectId(ctx, config.project);
  // Fetched before anything is written anywhere: an unreachable server fails
  // the whole run here, with nothing uploaded and the journal untouched.
  const remote: Record<string, string> = {};
  for (const entry of await pageAll(async (query) =>
    unwrap(
      await ctx.client().GET("/v1/projects/{projectId}/documents/manifest", {
        params: { path: { projectId }, query },
      }),
    ),
  )) {
    remote[entry.path] = entry.contentHash;
  }

  const local: Record<string, string> = {};
  for (const [path, file] of files) {
    local[path] = file.hash;
  }

  return {
    root,
    journalFile,
    config,
    projectId,
    matched,
    files,
    digest,
    journal,
    base,
    armed,
    remote,
    operations: plan({ paths: matched, base }, local, remote),
  };
}

function describeOperation(
  op: Operation,
  base: Record<string, string>,
): string {
  switch (op.op) {
    case "noop":
      return `in sync   ${op.path}`;
    case "push":
      // A first upload reported distinctly from an update (docs/10, control 5).
      return base[op.path] === undefined
        ? `new       ${op.path}`
        : `push      ${op.path}`;
    case "rebase":
      return op.hash === null
        ? `remote-deleted ${op.path} (re-based; the file stays, and the next sync uploads it as new)`
        : `remote-changed ${op.path} (re-based, nothing uploaded)`;
    case "conflict":
      return `CONFLICT  ${op.path} (both sides changed; standfast sync resolve ${op.path} --take-local | --take-remote)`;
    case "unseen":
      return `unseen    ${op.path} (still on the server; standfast doc rm removes it)`;
  }
}

function report(ctx: Ctx, prepared: Prepared, executed: boolean): void {
  const lines = prepared.operations.map((op) =>
    describeOperation(op, prepared.base),
  );
  out(
    ctx.format,
    lines.length === 0
      ? "Nothing matched the include globs."
      : lines.join("\n"),
    {
      root: prepared.root,
      project: prepared.config.project,
      matched: prepared.matched.length,
      executed,
      operations: prepared.operations,
    },
  );
}

function conflictCount(operations: Operation[]): number {
  return operations.filter((op) => op.op === "conflict").length;
}

/** `standfast sync status [dir]` — the same information on demand; changes nothing. */
export async function syncStatus(ctx: Ctx, fs: SyncFs = realFs): Promise<void> {
  report(ctx, await prepare(ctx, fs, ctx.args[0]), false);
}

/** `standfast sync [dir] [--accept]` — the one-shot. */
export async function syncRun(ctx: Ctx, fs: SyncFs = realFs): Promise<void> {
  const prepared = await prepare(ctx, fs, ctx.args[0]);

  // The blast-radius guard: a first run, or a scope whose resolved path list
  // changed, prints the whole plan and uploads nothing until a human accepts.
  if (!prepared.armed && !ctx.flags["accept"]) {
    report(ctx, prepared, false);
    throw new Error(
      `The scope of ${prepared.root} is new or has changed: ${prepared.matched.length} path(s) match, and nothing was uploaded. ` +
        "Review the plan above, then confirm it with: standfast sync --accept",
    );
  }

  // Between the plan above and the PUTs below the folder can change; the
  // upload sends the bytes the plan hashed, and the next run reconciles
  // whatever moved in between — accepted, no If-Match machinery.
  const nextBase: Record<string, string> = {};
  const unseen: string[] = [];
  for (const op of prepared.operations) {
    const before = prepared.base[op.path];
    switch (op.op) {
      case "push": {
        const file = prepared.files.get(op.path);
        if (!file) {
          throw new Error(`Planned a push for an unread path: ${op.path}`);
        }
        const doc = unwrap(
          await ctx.client().PUT("/v1/projects/{projectId}/documents", {
            params: { path: { projectId: prepared.projectId } },
            body: {
              path: op.path,
              title: basename(op.path),
              body: file.body,
            },
          }),
        );
        // The server's hash is the base, never the local guess: if the two
        // definitions ever drift, the next run surfaces it as a change
        // instead of hiding it forever.
        nextBase[op.path] = doc.contentHash;
        break;
      }
      case "rebase":
        if (op.hash !== null) {
          nextBase[op.path] = op.hash;
        }
        break;
      case "unseen":
        unseen.push(op.path);
        if (before !== undefined) {
          nextBase[op.path] = before;
        }
        break;
      default:
        // noop and conflict both keep the base they had: a conflict is
        // resolved by a human, not by the journal moving underneath one.
        if (before !== undefined) {
          nextBase[op.path] = before;
        }
    }
  }

  await saveJournal(prepared.journalFile, {
    project: prepared.config.project,
    scopeDigest: prepared.digest,
    base: nextBase,
    unseen,
  });

  report(ctx, prepared, true);
  const conflicts = conflictCount(prepared.operations);
  if (conflicts > 0) {
    throw new Error(
      `${conflicts} conflict(s): nothing was uploaded for them. A human resolves each with standfast sync resolve.`,
    );
  }
}

/** `standfast sync resolve <path> --take-local | --take-remote [dir]` */
export async function syncResolve(
  ctx: Ctx,
  fs: SyncFs = realFs,
): Promise<void> {
  const target = ctx.args[0];
  const takeLocal = Boolean(ctx.flags["take-local"]);
  const takeRemote = Boolean(ctx.flags["take-remote"]);
  if (!target || takeLocal === takeRemote) {
    throw new UsageError(
      "standfast sync resolve <path> --take-local | --take-remote [dir]",
    );
  }
  const prepared = await prepare(ctx, fs, ctx.args[1]);
  const journal = prepared.journal;
  if (journal === null || journal.project !== prepared.config.project) {
    throw new UsageError(
      `No sync journal for ${prepared.root}; run standfast sync first.`,
    );
  }

  if (takeLocal) {
    const file = prepared.files.get(target);
    if (!file) {
      // The allowlist gates this read too: a path outside the matched set was
      // never read, so there is nothing local to take.
      throw new UsageError(
        `${target} is not in the matched set of ${prepared.root}; the include globs decide what sync may read.`,
      );
    }
    const doc = unwrap(
      await ctx.client().PUT("/v1/projects/{projectId}/documents", {
        params: { path: { projectId: prepared.projectId } },
        body: { path: target, title: basename(target), body: file.body },
      }),
    );
    journal.base[target] = doc.contentHash;
  } else {
    // Take remote: re-base without uploading. The folder stays untouched —
    // sync never writes to it — so the next local edit conflicts again, which
    // is the accepted cost (docs/10).
    const remote = prepared.remote[target];
    if (remote === undefined) {
      delete journal.base[target];
    } else {
      journal.base[target] = remote;
    }
  }
  journal.unseen = journal.unseen.filter((path) => path !== target);
  await saveJournal(prepared.journalFile, journal);
  out(
    ctx.format,
    `resolved ${target} (${takeLocal ? "took local, pushed" : "took remote, re-based"})`,
    { path: target, took: takeLocal ? "local" : "remote" },
  );
}

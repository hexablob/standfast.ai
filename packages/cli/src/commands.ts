import { readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
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
export function unwrap<T>(result: {
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
export async function pageAll<T>(
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

/**
 * The `--limit` / `--offset` pair, parsed and refused in one place for every
 * command that paginates. Repeating this per command is how the two drift
 * apart, and a paging flag that parses on one listing and errors on the next
 * is worse than one that never existed.
 *
 * `parseArgs` has no numeric type, so both arrive as strings. Left to `Number`
 * alone, `--limit soon` would travel as `?limit=NaN` and come back a 400 about
 * a query parameter the user never typed; refusing here keeps the message
 * about the flag they actually got wrong.
 *
 * Absent keys are omitted rather than set to `undefined`.
 * `exactOptionalPropertyTypes` is on and the generated query types are exact,
 * so an explicit `undefined` is a type error rather than a harmless no-op.
 */
function pageQuery(ctx: Ctx): { limit?: number; offset?: number } {
  const query: { limit?: number; offset?: number } = {};

  for (const { flag, floor, shape } of [
    // A limit of 0 asks for nothing, and the server's own floor is 1. An
    // offset of 0 is the first page, so it has to survive the check.
    { flag: "limit", floor: 1, shape: "a positive integer" },
    { flag: "offset", floor: 0, shape: "a non-negative integer" },
  ] as const) {
    const raw = ctx.flags[flag];
    if (raw === undefined) continue;
    // `Number("")` is 0, which would let `--offset ""` through as a silent
    // success. Anything that is not a non-blank string is simply not a number.
    const value =
      typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < floor) {
      throw new UsageError(`--${flag} must be ${shape}`);
    }
    query[flag] = value;
  }

  return query;
}

/**
 * Appended to a listing that showed one page of a longer set.
 *
 * The sentence names the two flags because every listing that reaches this
 * function now accepts them. The one egress view that cannot paginate — the
 * per-destination summary, which the API returns as a plain array — never
 * calls it, so the advice is never offered where it would fail.
 */
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
  const page = unwrap(
    await ctx
      .client()
      .GET("/v1/projects", { params: { query: pageQuery(ctx) } }),
  );
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
      params: { path: { projectId }, query: pageQuery(ctx) },
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

/**
 * The explicit deletion path. `standfast sync` never deletes — absence is
 * reported, never applied (`docs/10-sync-daemon.md`) — so removing a document
 * from the server is always this: a human naming an id. The cascade is total
 * on purpose: the body, its sections and every atom quoting them go in one
 * statement, which is what makes it the privacy remedy.
 */
export async function documentRemove(ctx: Ctx): Promise<void> {
  const documentId = ctx.args[0];
  if (!documentId) {
    throw new UsageError(
      "standfast doc rm <document-id> (ids: standfast doc ls)",
    );
  }
  const res = await ctx.client().DELETE("/v1/documents/{documentId}", {
    params: { path: { documentId } },
  });
  if (!res.response.ok) {
    const detail =
      (res.error as { error?: string } | undefined)?.error ??
      res.response.statusText;
    throw new Error(`${res.response.status} ${detail}`);
  }
  out(ctx.format, `removed ${documentId}`, { id: documentId, removed: true });
}

export async function atomList(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  const atoms = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/atoms", {
      params: { path: { projectId }, query: pageQuery(ctx) },
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

/** The kinds the queue filters on; a typo should not become a 400. */
const ATOM_KINDS = ["decision", "convention", "constraint"] as const;

/**
 * The five the API accepts. Checked here so a typo is a usage error naming the
 * flag, rather than a 400 about a field the human never typed.
 *
 * Repeated from the enum rather than imported: `packages/cli` is Apache-2.0 and
 * depends on the SDK alone, so `@standfast/db` is not reachable from here. The
 * OpenAPI artifact is committed, and its diff is what catches a drift between
 * this list and the server's.
 */
const REJECT_REASONS = [
  "not_true",
  "duplicate",
  "not_a_decision",
  "wrong_severity",
  "document_is_wrong",
] as const;

/**
 * The provisional queue: what has been proposed and not yet decided.
 *
 * Printed in the order the API returned it and in no other. `docs/15-ratification.md`
 * makes the queue strict FIFO, oldest proposal first, and a client-side sort —
 * even one that looked like an improvement — would be this CLI quietly choosing
 * a different reading order than the one the document settled.
 */
export async function queueList(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  const query = {
    ...queueFilters(ctx),
    ...pageQuery(ctx),
  };
  const page = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/queue", {
      params: { path: { projectId }, query },
    }),
  );
  out(
    ctx.format,
    page.items.length === 0
      ? "Nothing awaiting ratification."
      : table([
          ["KIND", "STATEMENT", "DOCUMENT", "PROPOSED", "ID"],
          ...page.items.map((i) => [
            i.kind,
            i.statement.slice(0, 60),
            i.documentPath,
            i.proposedAt,
            i.id,
          ]),
        ]) + moreThanShown(page),
    page,
  );
}

/**
 * The queue's two filters, parsed in one place because `queue` and `next` read
 * the same list and a filter that narrowed the listing but not the next item
 * would show a human one atom and hand them another.
 *
 * Absent keys are omitted rather than set to `undefined`;
 * `exactOptionalPropertyTypes` is on and the generated query types are exact.
 */
function queueFilters(ctx: Ctx): { kind?: (typeof ATOM_KINDS)[number] } & {
  documentId?: string;
} {
  const requested = ctx.flags["kind"];
  const kind = ATOM_KINDS.find((k) => k === requested);
  if (requested !== undefined && kind === undefined) {
    throw new UsageError(`--kind must be one of ${ATOM_KINDS.join(", ")}`);
  }
  const documentId = ctx.flags["document"];
  return {
    ...(kind ? { kind } : {}),
    ...(typeof documentId === "string" && documentId !== ""
      ? { documentId }
      : {}),
  };
}

/**
 * The quote set back inside the section it was taken from, marked.
 *
 * `docs/15-ratification.md` puts the section body second in the reading order
 * and forbids collapsing it: the reviewer has to see what surrounds the quote
 * before reading the statement, because a sentence that reads as a decision on
 * its own may be an example, a rejected alternative, or someone else's position
 * in the paragraph that holds it. An ellipsis would hide exactly the words that
 * settle that.
 *
 * The span counts Unicode code points, so the slicing is done over `[...body]`
 * and not with `String.prototype.slice`, which counts UTF-16 code units and
 * would drift by one for every astral character earlier in the section — an
 * emoji in a heading is enough to mark the wrong words.
 *
 * If the span does not land on the recorded quote the section is printed
 * unmarked and the quote separately. Marking the wrong words would be a worse
 * failure than not marking any: it is the provenance a reviewer is being asked
 * to trust.
 */
export function quoteInSection(item: {
  sourceQuote: string;
  sourceSpan: { start: number; end: number };
  sectionBody: string;
}): string {
  const points = [...item.sectionBody];
  const { start, end } = item.sourceSpan;
  const marked = points.slice(start, end).join("");
  if (marked !== item.sourceQuote) {
    return `${item.sectionBody}\n\n  (characters ${start}–${end} of this section do not match the recorded quote, which reads: ${item.sourceQuote})`;
  }
  return `${points.slice(0, start).join("")}»${marked}«${points.slice(end).join("")}`;
}

/**
 * One atom, in full, in the order `docs/15-ratification.md` fixes: where it
 * came from, then the quote inside its section, then the statement, then the
 * kind. Provenance before claim, so the reviewer reads the document's words
 * before the model's paraphrase of them and cannot ratify the paraphrase by
 * having read nothing else.
 *
 * One atom and no flag that shows more. `docs/15-ratification.md` refuses bulk
 * approval, and a screen of twenty is how a human comes to answer them as a
 * batch.
 *
 * `--skip` is the document's Skip decision, and the cursor it moves is
 * deliberately client-side and stateless: the flag rides the queue route's
 * existing `offset`, so skipping writes no event, no status, no row anywhere —
 * exactly what "moves the cursor, writes nothing" requires. A server-side
 * per-reviewer cursor would also move the reviewer off the head of the queue,
 * and `docs/15-ratification.md` builds on the head being both the item on
 * screen and the queue-age metric — the same row, unable to drift apart.
 * Forgetting the skip on the next bare `next` is the feature: the atom nobody
 * decided is still at the head, still ageing, still first.
 */
export async function queueNext(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);

  // Same shape check as `pageQuery`, which owns `--limit`/`--offset`:
  // `Number("")` is 0, so a blank is not a number, and 0 itself is fine — it
  // is the head of the queue, which is what no flag means too.
  const rawSkip = ctx.flags["skip"];
  let skip = 0;
  if (rawSkip !== undefined) {
    const value =
      typeof rawSkip === "string" && rawSkip.trim() !== ""
        ? Number(rawSkip)
        : Number.NaN;
    if (!Number.isInteger(value) || value < 0) {
      throw new UsageError("--skip must be a non-negative integer");
    }
    skip = value;
  }

  const page = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/queue", {
      params: {
        path: { projectId },
        query: { ...queueFilters(ctx), limit: 1, offset: skip },
      },
    }),
  );

  const item = page.items[0];
  if (!item) {
    // Two different facts. An empty queue is done; a skip past the end is a
    // cursor pointing at nothing while the queue still waits. The window
    // total rides the rows, so a page past the end carries none — ask the
    // head for the real count before telling the reviewer which fact this is.
    let waiting = page.total;
    if (skip > 0) {
      const head = unwrap(
        await ctx.client().GET("/v1/projects/{projectId}/queue", {
          params: {
            path: { projectId },
            query: { ...queueFilters(ctx), limit: 1, offset: 0 },
          },
        }),
      );
      waiting = head.total;
    }
    out(
      ctx.format,
      skip > 0 && waiting > 0
        ? `Skipped past the end: ${waiting} awaiting ratification, none ${skip} deep.`
        : "Nothing awaiting ratification.",
      null,
    );
    return;
  }

  const heading =
    item.sectionHeadingPath.length > 0
      ? item.sectionHeadingPath.join(" › ")
      : "(no heading)";
  const proposer = item.proposedByName ?? "unknown";
  const kind = item.proposedByKind ? ` (${item.proposedByKind})` : "";

  // Reading-order item 6, last as the document orders it, and in full — the
  // incumbent is provenance for the supersede decision, and provenance is not
  // collapsible: no truncation, no expander. Absent when the server found no
  // canonical atom in the judge band, and nothing here goes looking.
  const incumbent = item.incumbent
    ? [
        "",
        `INCUMBENT  canonical, similarity ${item.incumbent.similarity.toFixed(2)} — ratifying with --supersedes replaces it`,
        "",
        item.incumbent.statement,
        "",
        `Atom       ${item.incumbent.id}`,
      ]
    : [];

  out(
    ctx.format,
    [
      `FROM       ${item.documentPath} › ${heading}  (section ${item.sectionOrdinal})`,
      "",
      "SECTION    the quote is marked »like this«",
      "",
      quoteInSection(item),
      "",
      `STATEMENT  ${item.statement}`,
      `KIND       ${item.kind}`,
      ...incumbent,
      "",
      `Proposed   ${item.proposedAt} by ${proposer}${kind}`,
      `Atom       ${item.id}`,
      "",
      `  standfast ratify ${item.id}`,
      // docs/15-ratification.md: `supersedes` is offered only when an
      // incumbent is on screen. No incumbent, no hint.
      ...(item.incumbent
        ? [`  standfast ratify ${item.id} --supersedes ${item.incumbent.id}`]
        : []),
      `  standfast reject ${item.id} --reason <${REJECT_REASONS.join("|")}>`,
      `\nShowing 1 of ${page.total} awaiting ratification.`,
    ].join("\n"),
    item,
  );
}

/**
 * Promotes one provisional atom, and one is the whole of it. There is no
 * `--all`: `docs/15-ratification.md` refuses bulk approval, because a queue a
 * human can empty with one command is a queue nobody read.
 *
 * The 403 (an agent cannot promote its own knowledge) travels out through
 * `unwrap` with the server's own sentence. The database refuses it too — the
 * composite foreign key, not this CLI — so restating the rule here would be a
 * second copy that could drift from the one that actually holds.
 */
export async function atomRatify(ctx: Ctx): Promise<void> {
  const atomId = ctx.args[0];
  if (!atomId) {
    throw new UsageError("standfast ratify <atom-id> [--supersedes <atom-id>]");
  }
  const supersedes = ctx.flags["supersedes"];
  const atom = unwrap(
    await ctx.client().POST("/v1/atoms/{atomId}/ratify", {
      params: {
        path: { atomId },
        query:
          typeof supersedes === "string" && supersedes !== ""
            ? { supersedes }
            : {},
      },
    }),
  );
  out(ctx.format, `${atom.status}  ${atom.statement}  ${atom.id}`, atom);
}

/**
 * Rejects one provisional atom. Terminal: `docs/15-ratification.md` makes
 * `rejected` an end state, so the reason is worth capturing at the moment it is
 * still known.
 *
 * `--reason` is optional at the API and stays optional here — requiring it
 * would be this CLI adding a rule the document did not — but a value outside
 * the five is refused before the request, so a typo reads as the flag it was.
 */
export async function atomReject(ctx: Ctx): Promise<void> {
  const atomId = ctx.args[0];
  if (!atomId) {
    throw new UsageError(
      "standfast reject <atom-id> [--reason <reason>] [--note <text>]",
    );
  }
  const requested = ctx.flags["reason"];
  const reason = REJECT_REASONS.find((r) => r === requested);
  if (requested !== undefined && reason === undefined) {
    throw new UsageError(
      `--reason must be one of ${REJECT_REASONS.join(", ")}`,
    );
  }
  const reasonNote = ctx.flags["note"];

  const atom = unwrap(
    await ctx.client().POST("/v1/atoms/{atomId}/reject", {
      params: { path: { atomId } },
      body: {
        ...(reason ? { reason } : {}),
        ...(typeof reasonNote === "string" ? { reasonNote } : {}),
      },
    }),
  );
  out(ctx.format, `${atom.status}  ${atom.statement}  ${atom.id}`, atom);
}

/**
 * Withdraws a canonical atom the project no longer stands behind. Not a
 * rejection — this one was ratified, held, and has been overtaken.
 */
export async function atomRetire(ctx: Ctx): Promise<void> {
  const atomId = ctx.args[0];
  if (!atomId) {
    throw new UsageError("standfast retire <atom-id>");
  }
  const atom = unwrap(
    await ctx.client().POST("/v1/atoms/{atomId}/retire", {
      params: { path: { atomId } },
    }),
  );
  out(ctx.format, `${atom.status}  ${atom.statement}  ${atom.id}`, atom);
}

const DURATION_UNITS: Record<string, number> = {
  "": 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/**
 * A duration a human would type, in the seconds the API asks for: `7d`, `36h`,
 * `90m`, `900s`, or a bare number already in seconds.
 *
 * The API takes seconds and nothing else, which is right for an API and wrong
 * for a flag somebody types at two in the afternoon wondering how much of the
 * backlog is over a week old. Converting here keeps the arithmetic out of the
 * human's head without putting a unit into the wire format.
 *
 * Refuses zero, which the API refuses too: "older than no time at all" is the
 * whole backlog, and a metric that quietly answered a different question than
 * the one asked is worse than one that errored.
 */
export function parseDuration(raw: string): number {
  const match = /^(\d+)(s|m|h|d|w)?$/.exec(raw.trim());
  const seconds = match
    ? Number(match[1]) * (DURATION_UNITS[match[2] ?? ""] ?? 1)
    : 0;
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new UsageError(
      `--older-than must be a duration like 7d, 36h, 90m, 900s, or a whole number of seconds (got ${raw})`,
    );
  }
  return seconds;
}

/**
 * Throughput and backlog: how much is waiting, how old the oldest is, how long
 * a decision takes, and how much of the queue is older than a window the human
 * chose.
 *
 * `--older-than` is required and has no default. `docs/02-principles.md` (10)
 * leaves the bar for this metric deliberately unchosen until there is something
 * to set it against, and a default here would become that bar by accident — the
 * number in the help text is the number everybody reports, and nobody would
 * remember it was picked to fill a flag rather than to mean anything.
 */
export async function ratification(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  const raw = ctx.flags["older-than"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UsageError(
      "standfast ratification --project <id> --older-than <duration>\n" +
        "There is no default window: the bar for this metric is deliberately unchosen (docs/02-principles.md, 10), and a default here would quietly become one.",
    );
  }

  const metric = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/ratification", {
      params: {
        path: { projectId },
        query: { olderThanSeconds: String(parseDuration(raw)) },
      },
    }),
  );

  // `null` where the queue is empty or nothing has been decided, and it is
  // printed as such. A zero in place of "no answer yet" would be a measurement
  // that was never taken, reported as one that was.
  const show = (value: number | string | null): string =>
    value === null ? "—" : String(value);

  out(
    ctx.format,
    table([
      ["Awaiting ratification", show(metric.backlog)],
      ["Oldest proposed at", show(metric.oldestProposedAt)],
      ["Oldest waiting (s)", show(metric.queueAgeSeconds)],
      [`Older than ${raw}`, show(metric.backlogOlderThan)],
      [`Share older than ${raw}`, show(metric.backlogShareOlderThan)],
      ["Decided", show(metric.decided)],
      ["Median seconds to decision", show(metric.medianSecondsToDecision)],
    ]),
    metric,
  );
}

/** The statuses the API filters on; a typo should not become a 400. */
const FINDING_STATUSES = ["recorded", "open", "accepted", "dismissed"] as const;

/**
 * The queue a human answers: what the last reconciliation run says the code no
 * longer honors.
 *
 * There is no rationale column, because the response carries no rationale —
 * it is written for the reviewer of that run, not served to whoever lists the
 * queue afterwards. Printing the location and the atom is the whole claim; a
 * line of the file itself would be this CLI pretending to have read code it
 * has never opened.
 */
export async function findingsList(ctx: Ctx): Promise<void> {
  const projectId = await requireProject(ctx);
  const requested = ctx.flags["status"];
  const status = FINDING_STATUSES.find((s) => s === requested);
  if (requested !== undefined && status === undefined) {
    throw new UsageError(
      `--status must be one of ${FINDING_STATUSES.join(", ")}`,
    );
  }

  const findings = unwrap(
    await ctx.client().GET("/v1/projects/{projectId}/findings", {
      params: {
        path: { projectId },
        query: { ...(status ? { status } : {}), ...pageQuery(ctx) },
      },
    }),
  );
  out(
    ctx.format,
    findings.items.length === 0
      ? "No findings."
      : table([
          ["STATUS", "VERDICT", "LOCATION", "ATOM", "ID"],
          ...findings.items.map((f) => [
            f.status,
            f.verdict,
            f.lineStart === null
              ? f.filePath
              : `${f.filePath}:${f.lineStart}-${f.lineEnd}`,
            f.atomId,
            f.id,
          ]),
        ]) + moreThanShown(findings),
    findings,
  );
}

/**
 * A human answers one finding, and answering is all this does. It does not
 * edit the file, deprecate the atom, or open a pull request — the CLI holds no
 * model and cannot read code, so any of those would be a guess wearing a
 * command's name.
 *
 * Exactly one of --accept / --dismiss is required. A default would be this
 * command answering on the human's behalf, which is the one thing the queue
 * exists to prevent. The 403 (an agent cannot close a question about its own
 * edit) and the 409 (a finding is answered once) already carry their sentence
 * from the server, so they travel out through `unwrap` rather than being
 * restated here as a second copy that would drift.
 */
export async function findingsResolve(ctx: Ctx): Promise<void> {
  const findingId = ctx.args[0];
  const accept = Boolean(ctx.flags["accept"]);
  const dismiss = Boolean(ctx.flags["dismiss"]);
  if (accept && dismiss) {
    throw new UsageError(
      "--accept and --dismiss are opposite answers; pass one.",
    );
  }
  if (!findingId || (!accept && !dismiss)) {
    throw new UsageError(
      "standfast findings resolve <finding-id> --accept | --dismiss",
    );
  }

  const finding = unwrap(
    await ctx.client().POST("/v1/findings/{findingId}/resolve", {
      params: { path: { findingId } },
      body: { status: accept ? "accepted" : "dismissed" },
    }),
  );
  out(
    ctx.format,
    `${finding.status}  ${finding.filePath}  ${finding.id}`,
    finding,
  );
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
    const events = unwrap(
      await ctx.client().GET("/v1/projects/{projectId}/egress/events", {
        params: { path: { projectId }, query: pageQuery(ctx) },
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { Problem } from "./corpus.js";

/**
 * Reading a directory of hand-written JSON without letting one bad file blank
 * the report.
 *
 * `check` exists to tell a labeller what is wrong while they are still in the
 * session. A loader that throws on the first invalid file spends that session's
 * feedback on whichever file happened to sort first: the corpus listing, the
 * coverage table and the agreement figures all vanish behind a stack trace, and
 * the trace locates the problem as `sections[12]`. Every file that parses is
 * still worth reporting on, and every file that does not is worth naming.
 */
export type Loaded<T> = { values: T[]; problems: Problem[] };

/** Keys that identify an item to a human, in the order they are preferred. */
const NAME_KEYS = ["headingPath", "id", "edit", "name", "queryId"] as const;

/**
 * A Zod issue path rendered as somewhere a human can look.
 *
 * `sections[12].expect[0].quote` says which array slot; it does not say which
 * *section*, and a labeller does not count array slots. Where the path passes
 * through an array of objects, the object's own identifying field is spliced in
 * — so the message names the heading, and the heading is what the file shows.
 */
export function locate(raw: unknown, path: readonly PropertyKey[]): string {
  let cursor: unknown = raw;
  let rendered = "";
  for (const step of path) {
    if (typeof step === "number") {
      rendered += `[${step}]`;
      cursor =
        Array.isArray(cursor) && step < cursor.length
          ? cursor[step]
          : undefined;
      const named = nameOf(cursor);
      if (named !== null) {
        rendered += ` '${named}' →`;
      }
      continue;
    }
    rendered +=
      rendered === "" || rendered.endsWith("→")
        ? `${rendered.endsWith("→") ? " " : ""}${String(step)}`
        : `.${String(step)}`;
    cursor =
      typeof cursor === "object" && cursor !== null
        ? (cursor as Record<string, unknown>)[String(step)]
        : undefined;
  }
  return rendered === "" ? "(whole file)" : rendered;
}

function nameOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  for (const key of NAME_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return value.length === 0 ? "(preamble)" : value.join(" › ");
    }
  }
  return null;
}

type FlatIssue = { path: PropertyKey[]; message: string };

/**
 * Union issues, unnested.
 *
 * A union reports its own failure as "Invalid input" at the union's own path
 * and hides the real reason one branch deeper — so `expect` being a union of
 * `"unread"` and a list would report every typo inside a labelled section as
 * `expect — Invalid input`, which is worse than what it replaced. The branch
 * that got furthest is the one the labeller meant, so its issues are what get
 * reported, at their full path.
 */
function flatten(issues: readonly unknown[]): FlatIssue[] {
  const flat: FlatIssue[] = [];
  for (const raw of issues) {
    const issue = raw as {
      path?: PropertyKey[];
      message?: string;
      errors?: unknown[][];
    };
    const path = issue.path ?? [];
    if (!issue.errors) {
      flat.push({ path, message: issue.message ?? "invalid" });
      continue;
    }
    // The branch whose complaint reaches deepest is the branch the writer was
    // aiming at; the others rejected the value at its first character.
    const deepest = issue.errors
      .map((branch) => flatten(branch))
      .sort(
        (a, b) =>
          Math.max(0, ...b.map((i) => i.path.length)) -
          Math.max(0, ...a.map((i) => i.path.length)),
      )[0];
    for (const nested of deepest ?? []) {
      flat.push({
        path: [...path, ...nested.path],
        message: nested.message,
      });
    }
  }
  return flat;
}

/**
 * Every `.json` file in `directory` that `accept`s, parsed against `schema`.
 *
 * A missing directory yields nothing and says nothing: a labelling pass that has
 * not started is not an error. A file that fails to parse becomes one Problem
 * per issue, naming the file and the item, and the other files still load.
 */
export function loadDirectory<T>(
  directory: string,
  accept: (name: string) => boolean,
  schema: z.ZodType<T>,
  label: (name: string) => string,
): Loaded<T> {
  if (!existsSync(directory)) {
    return { values: [], problems: [] };
  }

  const values: T[] = [];
  const problems: Problem[] = [];
  for (const name of readdirSync(directory)
    .filter((n) => n.endsWith(".json") && accept(n))
    .sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch (error) {
      problems.push({
        level: "error",
        message: `${label(name)}: not valid JSON — ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of flatten(parsed.error.issues)) {
        problems.push({
          level: "error",
          message: `${label(name)}: ${locate(raw, issue.path)} — ${issue.message}`,
        });
      }
      continue;
    }
    values.push(parsed.data);
  }
  return { values, problems };
}

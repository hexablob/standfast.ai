import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

type PgError = { code?: string; constraint?: string; message?: string };

/**
 * Drizzle wraps driver failures in its own error and puts the `pg` error on
 * `cause`, so reading `error.code` off the top-level throw finds nothing and
 * every constraint violation degrades to a 500. Walk the chain instead.
 *
 * The SQLSTATE shape is checked rather than the presence of a `code`, because
 * plenty of unrelated Node errors carry a `code` too (`ENOENT`, `ERR_*`).
 */
function findPgError(error: unknown): PgError {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as PgError;
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

/**
 * Messages for the constraints that exist to hold an invariant. A raw
 * `violates check constraint "atoms_ratifier_is_human"` is accurate and
 * useless; the caller needs to know what rule they hit.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  atoms_ratifier_is_human: "Only a human actor can ratify an atom.",
  atoms_canonical_requires_ratification:
    "An atom cannot be canonical without a ratifier and a ratification time.",
  atoms_source_quote_not_blank:
    "An atom must quote the text it is derived from.",
  atoms_ratified_by_human_fk: "Only a human actor can ratify an atom.",
};

/**
 * Maps a Postgres failure onto a status code.
 *
 * The one that matters is what is *absent*: there is no mapping from
 * row-level security to 403 on a read. A row another org owns is simply not
 * there, and answering 403 would confirm it exists. Not-found and not-yours
 * are indistinguishable from outside, which is a property of the design
 * rather than an accident of the query.
 */
export function toHttpException(error: unknown): HTTPException {
  const pg = findPgError(error);

  switch (pg.code) {
    case "23505":
      return new HTTPException(409, { message: "That already exists." });
    case "23503":
      return new HTTPException(422, {
        message: "A referenced record does not exist.",
      });
    case "23514":
      return new HTTPException(422, {
        message:
          CONSTRAINT_MESSAGES[pg.constraint ?? ""] ??
          "That violates a constraint on the record.",
      });
    case "42501":
      return new HTTPException(403, { message: "Not permitted." });
    default:
      return new HTTPException(500, { message: "Internal error." });
  }
}

export function notFound(): HTTPException {
  return new HTTPException(404, { message: "Not found." });
}

export async function handleErrors<T>(
  _c: Context,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw toHttpException(error);
  }
}

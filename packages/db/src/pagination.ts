import { sql } from "drizzle-orm";

/**
 * Pagination for every list endpoint, and the honesty that goes with it.
 *
 * `docs/14-roadmap.md` owns this as an Open item and `docs/03-architecture.md`
 * owns the design: "the envelope's `truncated` flag stops being honest the
 * moment a list endpoint drops rows". Three documents needed it and none had
 * it — the sync daemon wants `(path, content_hash)` per document without
 * downloading every body, git export hits the same at scale, and the MCP
 * server was capping `status` locally because the API could not.
 *
 * **The total comes from the same statement that applied the limit.** A window
 * function counts the whole filtered set while `LIMIT` returns a page of it, so
 * `truncated` is derived where the information actually exists rather than
 * inferred at a boundary that has already lost it. That distinction is the
 * point of the item: a caller comparing `items.length` against a number it
 * fetched separately is guessing, and a caller that slices a list and then
 * describes it is lying.
 */

/** The page size a caller gets for not asking. */
export const PAGE_DEFAULT = 50;

/**
 * The largest page anyone may ask for.
 *
 * A ceiling rather than a suggestion. Without one, `?limit=100000` is a way to
 * ask the API to do exactly what pagination was added to stop it doing.
 */
export const PAGE_MAX = 200;

export type Page = { readonly limit: number; readonly offset: number };

export type Paged<T> = {
  readonly items: T[];
  /** Rows matching the query, not rows returned. */
  readonly total: number;
  readonly returned: number;
  /** Whether rows exist beyond this page. Never recomputed downstream. */
  readonly truncated: boolean;
};

/**
 * Clamps a requested page into one the database may be asked for.
 *
 * The API's Zod schema clamps too, and the repetition is deliberate: this
 * package is used by the worker and the test suite as well as by the API, and a
 * bound that only one caller enforces is a bound the next caller forgets.
 */
export function pageOf(input?: {
  limit?: number | undefined;
  offset?: number | undefined;
}): Page {
  const limit = Math.min(
    Math.max(Math.trunc(input?.limit ?? PAGE_DEFAULT), 1),
    PAGE_MAX,
  );
  const offset = Math.max(Math.trunc(input?.offset ?? 0), 0);
  return { limit, offset };
}

/**
 * The window function every paginated query selects alongside its columns.
 *
 * `count(*) over ()` is evaluated before `LIMIT`, so it counts the whole
 * filtered set in the same round trip. A separate `select count(*)` would be a
 * second statement, doubling the tail latency of every listing in the product,
 * and it would be answering a question about a slightly different moment.
 */
export const PAGE_TOTAL = sql<number>`count(*) over ()`.as("pageTotal");

/**
 * Turns rows carrying `pageTotal` into an envelope, and drops the column.
 *
 * Named `pageTotal` rather than `total` so it cannot collide with a real column
 * on any table this is used with.
 *
 * An empty page reports `total: 0` — correct when the set is empty, and also
 * what an offset past the end returns. That second case is a caller asking for
 * page ten of a three-page list; reporting the real total there would mean a
 * second query, and reporting zero rows with nothing beyond them is not untrue.
 */
export function paged<T extends Record<string, unknown>>(
  rows: readonly (T & { pageTotal: number })[],
  page: Page,
): Paged<T> {
  const total = Number(rows[0]?.pageTotal ?? 0);
  const items = rows.map((row) => {
    const { pageTotal: _dropped, ...rest } = row;
    return rest as unknown as T;
  });

  return {
    items,
    total,
    returned: items.length,
    truncated: page.offset + items.length < total,
  };
}

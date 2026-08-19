import { and, desc, eq, getTableColumns } from "drizzle-orm";
import type { Db } from "../client.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import { projects } from "../schema/knowledge.js";

export type Project = typeof projects.$inferSelect;

/**
 * Repositories take the handle from `withActor` and never open their own
 * connection. Tenant scoping is the database's job — the `where` clauses here
 * are about intent, not isolation, and removing one would not leak anything.
 */
export async function listProjects(
  db: Db,
  page: Page,
): Promise<Paged<Project>> {
  const rows = await db
    .select({ ...getTableColumns(projects), pageTotal: PAGE_TOTAL })
    .from(projects)
    // `createdAt` alone is not a total order, and offset pagination over a
    // non-total order returns overlapping and missing rows across pages while
    // erroring on nothing. The id breaks every tie.
    .orderBy(desc(projects.createdAt), projects.id)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

export async function getProject(
  db: Db,
  projectId: string,
): Promise<Project | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0];
}

export async function createProject(
  db: Db,
  orgId: string,
  input: { name: string; slug: string },
): Promise<Project> {
  const rows = await db
    .insert(projects)
    .values({ orgId, name: input.name, slug: input.slug })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("insert returned no row");
  }
  return row;
}

export async function updateProject(
  db: Db,
  projectId: string,
  // `| undefined` is required by exactOptionalPropertyTypes: a PATCH body
  // legitimately carries an explicitly absent field.
  patch: { name?: string | undefined; slug?: string | undefined },
): Promise<Project | undefined> {
  if (patch.name === undefined && patch.slug === undefined) {
    return getProject(db, projectId);
  }
  const rows = await db
    .update(projects)
    .set(patch)
    .where(eq(projects.id, projectId))
    .returning();
  return rows[0];
}

export async function deleteProject(
  db: Db,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .delete(projects)
    .where(and(eq(projects.id, projectId)))
    .returning({ id: projects.id });
  return rows.length > 0;
}

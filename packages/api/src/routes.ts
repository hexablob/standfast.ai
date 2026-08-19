import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  countAtomsByStatus,
  createAtom,
  createProject,
  deleteDocument,
  deleteProject,
  type ExtractionEnqueue,
  getActorKind,
  getAtom,
  getDocument,
  getProject,
  getSection,
  listAtoms,
  listDocuments,
  listEgress,
  listProjects,
  listSections,
  liveExtraction,
  putDocument,
  ratifyAtom,
  summarizeEgress,
  updateProject,
} from "@standfast/db";
import { HTTPException } from "hono/http-exception";
import { handleErrors, notFound } from "./errors.js";
import { type AuthVariables, asTenant } from "./middleware/auth.js";
import {
  buildContext,
  NO_RETRIEVAL_PORTS,
  type RetrievalPorts,
  runSearch,
} from "./retrieval.js";
import {
  AtomSchema,
  AtomStatsSchema,
  ContextRequestSchema,
  ContextResponseSchema,
  CreateAtomSchema,
  CreateProjectSchema,
  DocumentSchema,
  EgressSummarySchema,
  ErrorSchema,
  PagedAtomSchema,
  PagedDocumentSchema,
  PagedEgressEventSchema,
  PagedProjectSchema,
  PagedSectionSchema,
  PageQuery,
  ProjectSchema,
  PutDocumentSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SectionSchema,
  UpdateProjectSchema,
  UuidParam,
} from "./schemas.js";

type App = OpenAPIHono<{ Variables: AuthVariables }>;

const security = [{ apiKey: [] }];

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const errors = {
  401: json(ErrorSchema, "Missing or invalid API key"),
  404: json(ErrorSchema, "Not found, or belongs to another org"),
};

/** ISO strings on the wire; the driver hands back Date objects. */
function serialize<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    }
  }
  return out as T;
}

export function registerRoutes(
  app: App,
  // Injected so a test can watch the enqueue without a queue behind it, and so
  // the version this process stamps into a job payload is one decision made in
  // one place rather than a default read at each call site.
  extraction: ExtractionEnqueue = liveExtraction(),
  // Injected for the same reason, and defaulting to neither model call bound.
  // A build with no ports opens no outbound socket and reports both stages as
  // skipped, which is what lets the whole read path run in CI with no network
  // and no secrets. Binding a provider is a deployment decision, and
  // docs/13-threat-model.md's egress allowlist is what governs it.
  retrieval: RetrievalPorts = NO_RETRIEVAL_PORTS,
): void {
  // ── projects ──────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects",
      tags: ["projects"],
      security,
      request: { query: PageQuery },
      responses: {
        200: json(PagedProjectSchema, "Projects in the caller's org"),
        ...errors,
      },
    }),
    async (c) => {
      const page = c.req.valid("query");
      const found = await handleErrors(c, () =>
        asTenant(c, (db) => listProjects(db, page)),
      );
      return c.json({ ...found, items: found.items.map(serialize) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/projects",
      tags: ["projects"],
      security,
      request: {
        body: {
          content: { "application/json": { schema: CreateProjectSchema } },
        },
      },
      responses: {
        201: json(ProjectSchema, "Created"),
        409: json(ErrorSchema, "Slug already used in this org"),
        ...errors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) => createProject(db, c.get("orgId"), input)),
      );
      return c.json(serialize(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}",
      tags: ["projects"],
      security,
      request: { params: z.object({ projectId: UuidParam }) },
      responses: { 200: json(ProjectSchema, "The project"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) => getProject(db, projectId)),
      );
      if (!row) {
        throw notFound();
      }
      return c.json(serialize(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/projects/{projectId}",
      tags: ["projects"],
      security,
      request: {
        params: z.object({ projectId: UuidParam }),
        body: {
          content: { "application/json": { schema: UpdateProjectSchema } },
        },
      },
      responses: { 200: json(ProjectSchema, "Updated"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const patch = c.req.valid("json");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) => updateProject(db, projectId, patch)),
      );
      if (!row) {
        throw notFound();
      }
      return c.json(serialize(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/projects/{projectId}",
      tags: ["projects"],
      security,
      request: { params: z.object({ projectId: UuidParam }) },
      responses: { 204: { description: "Deleted" }, ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const gone = await handleErrors(c, () =>
        asTenant(c, (db) => deleteProject(db, projectId)),
      );
      if (!gone) {
        throw notFound();
      }
      return c.body(null, 204);
    },
  );

  // ── documents ─────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/documents",
      tags: ["documents"],
      security,
      request: {
        params: z.object({ projectId: UuidParam }),
        query: PageQuery,
      },
      responses: { 200: json(PagedDocumentSchema, "Documents"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const page = c.req.valid("query");
      const found = await handleErrors(c, () =>
        asTenant(c, (db) => listDocuments(db, projectId, page)),
      );
      return c.json({ ...found, items: found.items.map(serialize) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/projects/{projectId}/documents",
      tags: ["documents"],
      security,
      description:
        "Creates or replaces a document by path. Sections are re-derived from the body; they are never supplied by the caller.",
      request: {
        params: z.object({ projectId: UuidParam }),
        body: {
          content: { "application/json": { schema: PutDocumentSchema } },
        },
      },
      responses: { 200: json(DocumentSchema, "Stored"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      // `sections` and `enqueued` are deliberately dropped here rather than
      // returned. What the write matched, inserted and deleted is extraction's
      // business, and the response body is the document — adding a work list to
      // it would put a queue detail on the wire and in the OpenAPI artifact.
      //
      // The enqueue itself happens inside putDocument, on this transaction. It
      // is not the route's to perform: the MCP server, the CLI and the future
      // sync daemon reach the same function, and each would have to remember.
      const { document } = await handleErrors(c, () =>
        asTenant(c, (db) =>
          putDocument(
            db,
            c.get("orgId"),
            projectId,
            {
              path: input.path,
              title: input.title ?? null,
              body: input.body,
            },
            extraction,
          ),
        ),
      );
      return c.json(serialize(document), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/documents/{documentId}",
      tags: ["documents"],
      security,
      request: { params: z.object({ documentId: UuidParam }) },
      responses: { 200: json(DocumentSchema, "The document"), ...errors },
    }),
    async (c) => {
      const { documentId } = c.req.valid("param");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) => getDocument(db, documentId)),
      );
      if (!row) {
        throw notFound();
      }
      return c.json(serialize(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/documents/{documentId}/sections",
      tags: ["documents"],
      security,
      request: {
        params: z.object({ documentId: UuidParam }),
        query: PageQuery,
      },
      responses: { 200: json(PagedSectionSchema, "Sections"), ...errors },
    }),
    async (c) => {
      const { documentId } = c.req.valid("param");
      const page = c.req.valid("query");
      const found = await handleErrors(c, () =>
        asTenant(c, (db) => listSections(db, documentId, page)),
      );
      return c.json({ ...found, items: found.items.map(serialize) }, 200);
    },
  );

  // A section is what an atom cites, so it has to be readable on its own —
  // otherwise verifying an atom's provenance means fetching its whole
  // document and searching for the right one.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sections/{sectionId}",
      tags: ["documents"],
      security,
      request: { params: z.object({ sectionId: UuidParam }) },
      responses: { 200: json(SectionSchema, "The section"), ...errors },
    }),
    async (c) => {
      const { sectionId } = c.req.valid("param");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) => getSection(db, sectionId)),
      );
      if (!row) {
        throw notFound();
      }
      return c.json(serialize(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/documents/{documentId}",
      tags: ["documents"],
      security,
      request: { params: z.object({ documentId: UuidParam }) },
      responses: { 204: { description: "Deleted" }, ...errors },
    }),
    async (c) => {
      const { documentId } = c.req.valid("param");
      const gone = await handleErrors(c, () =>
        asTenant(c, (db) => deleteDocument(db, documentId)),
      );
      if (!gone) {
        throw notFound();
      }
      return c.body(null, 204);
    },
  );

  // ── atoms ─────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/atoms",
      tags: ["atoms"],
      security,
      request: {
        params: z.object({ projectId: UuidParam }),
        query: PageQuery,
      },
      responses: { 200: json(PagedAtomSchema, "Atoms"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const page = c.req.valid("query");
      const found = await handleErrors(c, () =>
        asTenant(c, (db) => listAtoms(db, projectId, page)),
      );
      return c.json({ ...found, items: found.items.map(serialize) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/projects/{projectId}/atoms",
      tags: ["atoms"],
      security,
      description:
        "Creates a provisional atom. Status is server-assigned: the request schema has no status field, because everything an agent writes is born provisional.",
      request: {
        params: z.object({ projectId: UuidParam }),
        body: { content: { "application/json": { schema: CreateAtomSchema } } },
      },
      responses: {
        201: json(AtomSchema, "Created, provisional"),
        422: json(ErrorSchema, "Violates a constraint on the record"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) =>
          createAtom(db, c.get("orgId"), c.get("actorId"), {
            projectId,
            ...input,
          }),
        ),
      );
      return c.json(serialize(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/atoms/{atomId}",
      tags: ["atoms"],
      security,
      request: { params: z.object({ atomId: UuidParam }) },
      responses: { 200: json(AtomSchema, "The atom"), ...errors },
    }),
    async (c) => {
      const { atomId } = c.req.valid("param");
      const row = await handleErrors(c, () =>
        asTenant(c, (db) => getAtom(db, atomId)),
      );
      if (!row) {
        throw notFound();
      }
      return c.json(serialize(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/atoms/{atomId}/ratify",
      tags: ["atoms"],
      security,
      description:
        "Promotes a provisional atom to canonical. Only a human actor may do this; the composite foreign key enforces it, this check supplies the error message.",
      request: { params: z.object({ atomId: UuidParam }) },
      responses: {
        200: json(AtomSchema, "Ratified"),
        403: json(ErrorSchema, "The calling actor is an agent"),
        409: json(ErrorSchema, "The atom is not provisional"),
        ...errors,
      },
    }),
    async (c) => {
      const { atomId } = c.req.valid("param");
      const atomId_ = atomId;

      const row = await handleErrors(c, () =>
        asTenant(c, async (db) => {
          const kind = await getActorKind(db, c.get("actorId"));
          if (kind !== "human") {
            throw new HTTPException(403, {
              message:
                "Only a human actor can ratify an atom. An agent cannot promote its own knowledge.",
            });
          }

          const existing = await getAtom(db, atomId_);
          if (!existing) {
            throw notFound();
          }
          if (existing.status !== "provisional") {
            throw new HTTPException(409, {
              message: `Atom is ${existing.status}, not provisional.`,
            });
          }

          return ratifyAtom(db, c.get("orgId"), c.get("actorId"), atomId_);
        }),
      );

      if (!row) {
        throw notFound();
      }
      return c.json(serialize(row), 200);
    },
  );

  // ── egress ────────────────────────────────────────────────────────────
  //
  // The read side of docs/13-threat-model.md (*Egress*, rule 3). The record
  // itself is written by the worker, before each outbound call; these two
  // routes are what turn it from a table into an answer somebody can ask for.
  //
  // Deliberately not an MCP tool. The six in docs/08-mcp-server.md serve an
  // agent working on a file; "what has this project sent to a provider" is a
  // question a person asks about the deployment, and spending one of ten tool
  // slots on it would charge every session for it.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/egress",
      tags: ["egress"],
      security,
      description:
        "What has left this project, to which provider, as which pinned model, and how much of it. Grouped by purpose, destination and model version, so a change of pin shows as its own row rather than being averaged away.",
      request: { params: z.object({ projectId: UuidParam }) },
      responses: {
        200: json(z.array(EgressSummarySchema), "Grouped by allowlist entry"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const rows = await handleErrors(c, () =>
        asTenant(c, (db) => summarizeEgress(db, projectId)),
      );
      return c.json(
        rows.map((row) => ({
          purpose: row.purpose,
          destination: row.destination,
          model: row.model,
          calls: row.calls,
          items: row.items,
          chars: row.chars,
          firstAt: row.firstAt.toISOString(),
          lastAt: row.lastAt.toISOString(),
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/egress/events",
      tags: ["egress"],
      security,
      description:
        "The individual calls, most recent first. Each row is a measurement — how many pieces of prose and how many characters — and never a copy of what was sent.",
      request: {
        params: z.object({ projectId: UuidParam }),
        query: PageQuery,
      },
      responses: {
        200: json(PagedEgressEventSchema, "Outbound calls"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const page = c.req.valid("query");
      const found = await handleErrors(c, () =>
        asTenant(c, (db) => listEgress(db, projectId, page)),
      );
      // Projected field by field rather than spread. `serialize` would put
      // `org_id` on the wire as a side effect of the row's shape, and the one
      // table whose entire purpose is disclosure is the last place to let the
      // payload be decided by whatever the SELECT happened to return.
      return c.json(
        {
          ...found,
          items: found.items.map((row) => ({
            id: row.id,
            projectId: row.projectId,
            sectionId: row.sectionId,
            purpose: row.purpose,
            destination: row.destination,
            model: row.model,
            inputItems: row.inputItems,
            inputChars: row.inputChars,
            at: row.at.toISOString(),
          })),
        },
        200,
      );
    },
  );

  /**
   * Counts, not a page.
   *
   * `docs/03-architecture.md` calls the MCP server's local scan limit a cap in
   * the wrong layer. It was worse than that: `status` fetched every atom in a
   * project to produce four numbers, and past the cap the numbers described an
   * arbitrary prefix — a project with six hundred atoms under-reported the
   * ratification queue, which `docs/02-principles.md` (5) calls a first-class
   * product metric. Counting in the database is exact at any size, and the tool
   * stops needing a cap at all.
   */
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/atoms/stats",
      tags: ["atoms"],
      security,
      request: { params: z.object({ projectId: UuidParam }) },
      responses: {
        200: json(AtomStatsSchema, "How many atoms, by status"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const counts = await handleErrors(c, () =>
        asTenant(c, (db) => countAtomsByStatus(db, projectId)),
      );
      return c.json(
        // Named rather than left for the caller to work out. An agent reading
        // "provisional" has to know that provisional means waiting on a human;
        // the queue is the thing the product is trying to move, so it is a
        // field.
        { ...counts, awaitingRatification: counts.provisional },
        200,
      );
    },
  );

  // ── retrieval ─────────────────────────────────────────────────────────
  //
  // POST rather than GET for both. The query is a task description, the paths
  // are a list, and a budget is a number — a body, not a query string. It also
  // keeps a developer's task description out of access logs and out of
  // `Referer` headers, which matters more here than the cacheability a GET
  // would buy on a response that is never the same twice.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/projects/{projectId}/context",
      tags: ["retrieval"],
      security,
      request: {
        params: z.object({ projectId: UuidParam }),
        body: {
          content: { "application/json": { schema: ContextRequestSchema } },
        },
      },
      responses: {
        200: json(ContextResponseSchema, "The atoms that govern this work"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");

      const pack = await handleErrors(c, () =>
        asTenant(c, (db) =>
          buildContext(
            db,
            retrieval,
            {
              orgId: c.get("orgId"),
              projectId,
              scope: input.scope,
              query: input.query ?? null,
              paths: input.paths,
              documentId: input.documentId ?? null,
              sectionId: input.sectionId ?? null,
              budgetTokens: input.budgetTokens,
            },
            // A ceiling, not a target. The p95 contract is Open in
            // docs/14-roadmap.md and unchoosable until a corpus exists; this
            // is only the point past which a hung model call stops being
            // something the caller should keep waiting for.
            AbortSignal.timeout(10_000),
          ),
        ),
      );

      return c.json(pack, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/projects/{projectId}/search",
      tags: ["retrieval"],
      security,
      request: {
        params: z.object({ projectId: UuidParam }),
        body: {
          content: { "application/json": { schema: SearchRequestSchema } },
        },
      },
      responses: {
        200: json(
          SearchResponseSchema,
          "Ranked atoms, with what they project from",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");

      const found = await handleErrors(c, () =>
        asTenant(c, (db) =>
          runSearch(
            db,
            retrieval,
            {
              orgId: c.get("orgId"),
              projectId,
              query: input.query,
              mode: input.mode,
              limit: input.limit,
            },
            AbortSignal.timeout(10_000),
          ),
        ),
      );

      return c.json(found, 200);
    },
  );
}

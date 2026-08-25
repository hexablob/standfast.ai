import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { FINDING_STATUSES } from "@standfast/core";
import {
  countAtomsByStatus,
  countDrift,
  createAtom,
  createProject,
  deleteDocument,
  deleteProject,
  type ExtractionEnqueue,
  type Finding,
  getActorKind,
  getAtom,
  getDocument,
  getProject,
  getSection,
  listAtoms,
  listDocumentManifest,
  listDocuments,
  listEgress,
  listFindings,
  listProjects,
  listQueue,
  listSections,
  liveExtraction,
  putDocument,
  queueStats,
  ratificationThroughput,
  ratifyAtom,
  recordReconciliation,
  rejectAtom,
  resolveFinding,
  retireAtom,
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
  FindingSchema,
  PagedAtomSchema,
  PagedDocumentManifestEntrySchema,
  PagedDocumentSchema,
  PagedEgressEventSchema,
  PagedFindingSchema,
  PagedProjectSchema,
  PagedQueueItemSchema,
  PagedSectionSchema,
  PageQuery,
  ProjectSchema,
  PutDocumentSchema,
  RatificationSchema,
  RatifyAtomSchema,
  ReconcileAckSchema,
  ReconcileRequestSchema,
  RejectAtomSchema,
  ResolveFindingSchema,
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

/**
 * An atom on its way out.
 *
 * Separate from `serialize` because one field genuinely changes *type* rather
 * than format: Postgres hands an `int4range` back as the literal `"[7,19)"`,
 * and the wire carries `{ start, end }`. Folding that into the generic helper
 * made it lie about its own return type, and the type checker said so.
 *
 * Converted here rather than in the repository so every atom-returning route
 * inherits it instead of each one remembering to.
 */
function serializeAtom<T extends { sourceSpan: string }>(
  row: T,
): Omit<T, "sourceSpan"> & { sourceSpan: { start: number; end: number } } {
  const { sourceSpan, ...rest } = serialize(row);
  return { ...rest, sourceSpan: parseSpan(sourceSpan) };
}

/**
 * `"[7,19)"` becomes `{ start: 7, end: 19 }`.
 *
 * Half-open is the only form this schema writes — `createAtom` builds
 * `[start,end)` — so the parser insists on it rather than quietly accepting a
 * closed range and being wrong by one at the end. A range Postgres normalised
 * to `empty` cannot reach here: `atoms_source_span_not_empty` refuses it on the
 * way in, which is part of why that constraint exists.
 */
function parseSpan(range: string): { start: number; end: number } {
  const match = /^\[(\d+),(\d+)\)$/.exec(range);
  if (!match?.[1] || !match[2]) {
    throw new Error(`source_span is not a half-open int4range: ${range}`);
  }
  return { start: Number(match[1]), end: Number(match[2]) };
}

/**
 * A finding, on its way out.
 *
 * Deliberately an explicit field list rather than a spread, and that is the
 * whole point of the function: `rationale` is the one free-text field on the
 * reconciliation path, and a `{ ...row }` would serve it to the next agent that
 * calls the list endpoint the moment somebody adds a column. It is written for
 * the human working the queue. `orgId` goes for the ordinary reason — the
 * caller is inside exactly one org and telling it which is telling it nothing.
 */
function serializeFinding(row: Finding): {
  id: string;
  projectId: string;
  runId: string;
  atomId: string;
  verdict: Finding["verdict"];
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  status: Finding["status"];
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
} {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    atomId: row.atomId,
    verdict: row.verdict,
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    status: row.status,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
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

  // A dedicated route, deliberately not a `?fields=` parameter on the list
  // above: one response shape per route keeps the generated SDK monomorphic,
  // and the no-bodies guarantee is enforced by the repository's SELECT itself,
  // not by post-filtering a wider row.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/documents/manifest",
      tags: ["documents"],
      security,
      description:
        "The sync manifest: `(id, path, contentHash)` per document, ordered by path. Bodies are never selected.",
      request: {
        params: z.object({ projectId: UuidParam }),
        query: PageQuery,
      },
      responses: {
        200: json(PagedDocumentManifestEntrySchema, "Manifest"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const page = c.req.valid("query");
      const found = await handleErrors(c, () =>
        asTenant(c, async (db) => {
          // An absent project is a 404, never an empty page: a sync reading an
          // empty manifest for a mistyped project id would conclude every
          // local file is new. Another org's project is absent under RLS, so
          // not-found and not-yours stay indistinguishable from outside.
          const project = await getProject(db, projectId);
          if (!project) {
            throw notFound();
          }
          return listDocumentManifest(db, projectId, page);
        }),
      );
      // No `serialize`: nothing on this shape is a Date.
      return c.json(found, 200);
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
      // `staleCitations` is dropped for the same reason: an atom whose quote no
      // longer appears in its rewritten section is recorded for a human to rule
      // on, not returned to whoever pushed the document. It appears in no Zod
      // schema and no wire type, and that is deliberate.
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
      return c.json({ ...found, items: found.items.map(serializeAtom) }, 200);
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
      return c.json(serializeAtom(row), 201);
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
      return c.json(serializeAtom(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/atoms/{atomId}/ratify",
      tags: ["atoms"],
      security,
      description:
        "Promotes a provisional atom to canonical, optionally superseding the atom it replaces. Only a human actor may do this; the composite foreign key enforces it, this check supplies the error message.",
      request: {
        params: z.object({ atomId: UuidParam }),
        /**
         * `supersedes` is a query parameter rather than a body field, and the
         * reason is compatibility rather than taste.
         *
         * Ratification has always been a bodyless `POST`. A client that sends
         * `Content-Type: application/json` with no body — which is what every
         * caller here does — makes an optional JSON body a parse error, so
         * declaring one turns the common path into a 400 for the sake of a
         * field most callers never set. `required: false` does not help: the
         * validator still runs.
         *
         * It stays one route and one decision either way, which is what
         * `docs/15-ratification.md` actually settles: superseding is not a
         * second call whose atomicity is the caller's problem.
         */
        query: RatifyAtomSchema,
      },
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

          const { supersedes } = c.req.valid("query");
          try {
            return await ratifyAtom(
              db,
              c.get("orgId"),
              c.get("actorId"),
              atomId_,
              supersedes,
            );
          } catch (error) {
            // The repository throws when the incumbent is not canonical, is in
            // another project, or is the candidate itself — and the throw is
            // what rolls the candidate's promotion back. Both atoms move or
            // neither does; a half-applied supersede would leave two canonical
            // atoms making the same claim.
            if (supersedes && error instanceof Error) {
              throw new HTTPException(409, {
                message:
                  "The atom being superseded is not a canonical atom of this project.",
              });
            }
            throw error;
          }
        }),
      );

      if (!row) {
        throw notFound();
      }
      return c.json(serializeAtom(row), 200);
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
      const { counts, drift } = await handleErrors(c, () =>
        asTenant(c, async (db) => ({
          counts: await countAtomsByStatus(db, projectId),
          drift: await countDrift(db, projectId),
        })),
      );
      return c.json(
        // Named rather than left for the caller to work out. An agent reading
        // "provisional" has to know that provisional means waiting on a human;
        // the queue is the thing the product is trying to move, so it is a
        // field.
        { ...counts, ...drift, awaitingRatification: counts.provisional },
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

  // ── ratification ──────────────────────────────────────────────────────
  //
  // Phase 4, and the reason it exists: the bottleneck in this product is a human
  // reading provisional atoms (`docs/02-principles.md`, 5). Nothing in phases 1
  // to 3 moves that by a single atom.
  //
  // Every route below refuses an agent with a 403. **The 403 is the message, not
  // the guarantee.** Migration 0013 put `actor_kind` on `atom_events`, keyed into
  // `actors (id, kind)` and checked so that every event except `proposed` belongs
  // to a human — so an agent that reached the table by any other path is refused
  // by the database. These checks exist so the refusal arrives as a sentence
  // somebody can read rather than as a constraint name.

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/atoms/{atomId}/reject",
      tags: ["atoms"],
      security,
      description:
        "Rejects a provisional atom. Terminal. The optional reason is a closed vocabulary, and it is what turns a reviewer's ordinary work into the labelled corpus extraction precision is measured against.",
      request: {
        params: z.object({ atomId: UuidParam }),
        /**
         * Optional — but note the trap, because it has bitten this codebase
         * twice. `required: false` does not stop Hono parsing the body, so a
         * client that sends `Content-Type: application/json` with an *empty*
         * body gets a 400, while one that sends no body and no content type
         * succeeds. A client with nothing to say should send `{}`.
         *
         * This is the same behaviour that pushed `supersedes` onto ratify's
         * query string. It is tolerable here because a rejection reason is a
         * real payload with two fields, and any client that wants to send one
         * is sending a body anyway.
         */
        body: {
          required: false,
          content: { "application/json": { schema: RejectAtomSchema } },
        },
      },
      responses: {
        200: json(AtomSchema, "Rejected"),
        403: json(ErrorSchema, "The calling actor is an agent"),
        409: json(ErrorSchema, "The atom is not provisional"),
        ...errors,
      },
    }),
    async (c) => {
      const { atomId } = c.req.valid("param");
      const body = c.req.valid("json") ?? {};

      const row = await handleErrors(c, () =>
        asTenant(c, async (db) => {
          const kind = await getActorKind(db, c.get("actorId"));
          if (kind !== "human") {
            throw new HTTPException(403, {
              message:
                "Only a human actor can reject an atom. An agent cannot decide what its own proposal was worth.",
            });
          }

          // Read first, exactly as the ratify route does. The read is scoped by
          // row-level security, so an atom in another org simply is not there
          // and the answer is 404 — which leaks nothing, because it is the same
          // answer as for an id that never existed. Merging that into the 409
          // would have made "not yours" and "already decided" indistinguishable
          // to a caller acting in good faith, for no security gain.
          const existing = await getAtom(db, atomId);
          if (!existing) {
            throw notFound();
          }
          if (existing.status !== "provisional") {
            throw new HTTPException(409, {
              message: `Atom is ${existing.status}, not provisional.`,
            });
          }

          const rejected = await rejectAtom(
            db,
            c.get("orgId"),
            c.get("actorId"),
            atomId,
            body.reason,
            body.reasonNote,
          );
          if (!rejected) {
            // Lost a race with another decision between the read and the write.
            throw new HTTPException(409, {
              message: "Atom is no longer provisional.",
            });
          }
          return rejected;
        }),
      );

      return c.json(serializeAtom(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/atoms/{atomId}/retire",
      tags: ["atoms"],
      security,
      description:
        "Withdraws a canonical atom that has no successor. Terminal, and deliberately not a rejection: `rejected` means a human said no to a proposal, and a retired atom was right until the world moved on.",
      request: { params: z.object({ atomId: UuidParam }) },
      responses: {
        200: json(AtomSchema, "Retired"),
        403: json(ErrorSchema, "The calling actor is an agent"),
        409: json(ErrorSchema, "The atom is not canonical"),
        ...errors,
      },
    }),
    async (c) => {
      const { atomId } = c.req.valid("param");

      const row = await handleErrors(c, () =>
        asTenant(c, async (db) => {
          const kind = await getActorKind(db, c.get("actorId"));
          if (kind !== "human") {
            throw new HTTPException(403, {
              message:
                "Only a human actor can retire an atom. Withdrawing a decision the project made is not an agent's call.",
            });
          }

          const existing = await getAtom(db, atomId);
          if (!existing) {
            throw notFound();
          }
          if (existing.status !== "canonical") {
            throw new HTTPException(409, {
              message: `Atom is ${existing.status}, not canonical.`,
            });
          }

          const retired = await retireAtom(
            db,
            c.get("orgId"),
            c.get("actorId"),
            atomId,
          );
          if (!retired) {
            throw new HTTPException(409, {
              message: "Atom is no longer canonical.",
            });
          }
          return retired;
        }),
      );

      return c.json(serializeAtom(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/queue",
      tags: ["atoms"],
      security,
      description:
        "The provisional queue, oldest first, with the section each atom was projected from. The section body is returned whole: provenance is what the decision rests on, and a reviewer who has to fetch it separately is a reviewer who stops checking it.",
      request: {
        params: z.object({ projectId: UuidParam }),
        query: PageQuery.extend({
          kind: z.enum(["decision", "convention", "constraint"]).optional(),
          documentId: UuidParam.optional(),
        }),
      },
      responses: { 200: json(PagedQueueItemSchema, "The queue"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { limit, offset, kind, documentId } = c.req.valid("query");

      const found = await handleErrors(c, () =>
        asTenant(c, (db) =>
          listQueue(
            db,
            projectId,
            { limit, offset },
            // Absent rather than present-and-undefined: the repository's filter
            // type is exact.
            {
              ...(kind === undefined ? {} : { kind }),
              ...(documentId === undefined ? {} : { documentId }),
            },
          ),
        ),
      );

      return c.json({ ...found, items: found.items.map(serializeAtom) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/ratification",
      tags: ["atoms"],
      security,
      description:
        "Ratification throughput: the median time from proposal to decision, and how much of the backlog is older than an age you name. The age is required because no bar has been chosen for this metric, and a default here would be one invented by accident.",
      request: {
        params: z.object({ projectId: UuidParam }),
        query: z.object({
          // Required, and that is the point. `docs/14-roadmap.md` leaves this
          // metric's bar unchosen, and a default here would quietly become it.
          //
          // Parsed from a string rather than coerced: a query parameter *is* a
          // string, `z.coerce` would take `unknown` as its input type, and
          // `PageQuery` only gets away with coercion because its defaults pin
          // the type down. Being explicit also means `?olderThanSeconds=abc`
          // fails as a 400 rather than arriving as `NaN`.
          olderThanSeconds: z
            .string()
            .regex(/^\d+$/, "olderThanSeconds is a whole number of seconds.")
            .transform(Number)
            .pipe(z.number().int().min(1)),
        }),
      },
      responses: {
        200: json(RatificationSchema, "Throughput and backlog"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { olderThanSeconds } = c.req.valid("query");

      const { throughput, stats } = await handleErrors(c, () =>
        asTenant(c, async (db) => ({
          throughput: await ratificationThroughput(
            db,
            projectId,
            olderThanSeconds,
          ),
          // Reported beside the metric, and computed over the *unfiltered*
          // queue: `docs/15-ratification.md` is explicit that backlog and queue
          // age describe the work outstanding, not the slice someone is looking
          // at. `queueStats` takes no filter argument at all, which is the only
          // form a caller cannot get wrong.
          stats: await queueStats(db, projectId),
        })),
      );

      return c.json(
        {
          ...throughput,
          oldestProposedAt: stats.oldestProposedAt?.toISOString() ?? null,
          queueAgeSeconds: stats.queueAgeSeconds,
        },
        200,
      );
    },
  );

  // ── reconciliation ────────────────────────────────────────────────────
  //
  // Phase 3, and the moat: `docs/02-principles.md` (1) — keeping a record of
  // decisions is trivial, knowing whether the code still honors them is not.
  //
  // The agent reads the code in its own session, on the customer's machine, and
  // sends back a verdict and a pointer. Nothing here is a second ingress: same
  // `requireApiKey` on `/v1/*`, same `asTenant` into `withActor`, same tenancy
  // boundary. A separate surface for this would have been a second auth path to
  // get wrong.

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/projects/{projectId}/reconciliations",
      tags: ["reconciliation"],
      security,
      description:
        "Records one run of verdicts on whether code still honors the atoms that govern it. No field accepts source code. Verdicts are recorded and never acted on: nothing here edits code, opens a pull request, or changes an atom.",
      request: {
        params: z.object({ projectId: UuidParam }),
        body: {
          content: { "application/json": { schema: ReconcileRequestSchema } },
        },
      },
      responses: {
        201: json(ReconcileAckSchema, "Recorded"),
        422: json(ErrorSchema, "Violates a constraint on the record"),
        ...errors,
      },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const input = c.req.valid("json");

      const ack = await handleErrors(c, () =>
        asTenant(c, async (db) => {
          const project = await getProject(db, projectId);
          if (!project) {
            throw notFound();
          }

          return recordReconciliation(db, {
            orgId: c.get("orgId"),
            projectId,
            actorId: c.get("actorId"),
            // Reaches the row and nothing reads it. It is a claim the client
            // makes about its own loop, so no branch here may key on it.
            trigger: input.trigger,
            items: input.items,
          });
        }),
      );

      return c.json(ack, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/projects/{projectId}/findings",
      tags: ["reconciliation"],
      security,
      description:
        "The human queue. Filter by status; open findings are the violations waiting on an answer. The rationale is never served — it is written for the human reviewing the queue, not for the next agent to read.",
      request: {
        params: z.object({ projectId: UuidParam }),
        query: PageQuery.extend({
          status: z.enum(FINDING_STATUSES).optional(),
        }),
      },
      responses: { 200: json(PagedFindingSchema, "Findings"), ...errors },
    }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { limit, offset, status } = c.req.valid("query");

      const found = await handleErrors(c, () =>
        asTenant(c, (db) =>
          listFindings(db, projectId, status, { limit, offset }),
        ),
      );

      return c.json(
        { ...found, items: found.items.map(serializeFinding) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/findings/{findingId}/resolve",
      tags: ["reconciliation"],
      security,
      description:
        "A human answers one open finding. Only a human actor may do this; the composite foreign key enforces it, this check supplies the error message. Nothing is deleted — a dismissed finding is the numerator of this product's own kill metric.",
      request: {
        params: z.object({ findingId: UuidParam }),
        body: {
          content: { "application/json": { schema: ResolveFindingSchema } },
        },
      },
      responses: {
        200: json(FindingSchema, "Resolved"),
        403: json(ErrorSchema, "The calling actor is an agent"),
        409: json(ErrorSchema, "The finding is not open"),
        ...errors,
      },
    }),
    async (c) => {
      const { findingId } = c.req.valid("param");
      const { status } = c.req.valid("json");

      const row = await handleErrors(c, () =>
        asTenant(c, async (db) => {
          const kind = await getActorKind(db, c.get("actorId"));
          if (kind !== "human") {
            throw new HTTPException(403, {
              message:
                "Only a human actor can resolve a finding. An agent cannot close a question about its own edit.",
            });
          }

          const resolved = await resolveFinding(
            db,
            findingId,
            c.get("actorId"),
            status,
          );
          if (!resolved) {
            // Either it does not exist, or it is already answered. The
            // conditional update cannot tell those apart in one statement, and
            // a second read to distinguish them would leak whether a finding
            // exists in another org.
            throw new HTTPException(409, {
              message:
                "Finding is not open. A finding is answered once; there is no reopen.",
            });
          }
          return resolved;
        }),
      );

      return c.json(serializeFinding(row), 200);
    },
  );
}

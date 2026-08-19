import { z } from "@hono/zod-openapi";
import { EGRESS_PURPOSES } from "@standfast/core";
import { PAGE_DEFAULT, PAGE_MAX } from "@standfast/db";

/**
 * Zod schemas are the single source: the OpenAPI document, the typed client
 * and the CLI are all derived from these, so a field that is absent here does
 * not exist anywhere downstream.
 */

export const UuidParam = z.uuid();

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

export const ProjectSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Project");

export const CreateProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens"),
  })
  .openapi("CreateProject");

export const UpdateProjectSchema =
  CreateProjectSchema.partial().openapi("UpdateProject");

export const DocumentSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    projectId: z.uuid(),
    path: z.string(),
    title: z.string().nullable(),
    body: z.string(),
    contentHash: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Document");

export const PutDocumentSchema = z
  .object({
    path: z.string().min(1).max(1024),
    title: z.string().max(500).nullish(),
    body: z.string(),
  })
  .openapi("PutDocument");

export const SectionSchema = z
  .object({
    id: z.uuid(),
    documentId: z.uuid(),
    ordinal: z.number().int(),
    headingPath: z.array(z.string()),
    body: z.string(),
    sectionHash: z.string(),
  })
  .openapi("DocumentSection");

export const AtomSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    projectId: z.uuid(),
    documentId: z.uuid(),
    sectionId: z.uuid(),
    statement: z.string(),
    kind: z.enum(["decision", "convention", "constraint"]),
    status: z.enum(["provisional", "canonical", "rejected", "superseded"]),
    sourceQuote: z.string(),
    ratifiedBy: z.uuid().nullable(),
    ratifiedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Atom");

/**
 * `status` is absent on purpose.
 *
 * Everything an agent writes is born provisional (invariant 2). Leaving the
 * field out means a client asking for `"canonical"` is not an argument the
 * API has to win — the request simply cannot express it, and the schema says
 * so to every generated client.
 */
export const CreateAtomSchema = z
  .object({
    documentId: z.uuid(),
    sectionId: z.uuid(),
    statement: z.string().min(1).max(2000),
    kind: z.enum(["decision", "convention", "constraint"]),
    sourceQuote: z.string().min(1),
    sourceSpan: z.object({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    }),
  })
  .openapi("CreateAtom");

/**
 * The page a caller asks for, and the envelope it gets back.
 *
 * `docs/03-architecture.md` owns this. The bounds are imported from
 * `@standfast/db` rather than restated, so the ceiling has one home — a maximum
 * the API enforces and the repository does not is a maximum the next caller
 * gets around.
 *
 * `z.coerce` because query parameters arrive as strings and a client writing
 * `?limit=10` should not have to know that.
 */
export const PageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_MAX)
    .default(PAGE_DEFAULT)
    .describe(`Rows per page, at most ${PAGE_MAX}.`),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * One shape for every list endpoint.
 *
 * `truncated` is computed by the query that applied the limit — a window
 * function counts the whole filtered set in the same statement — and is
 * carried through untouched. `docs/02-principles.md` anti-patterns: do not
 * return a truncated result set without telling the agent it was truncated.
 * The MCP server and the CLI both read this field rather than comparing counts,
 * because by the time a boundary can compare two numbers it has already lost
 * the one that mattered.
 */
function pagedOf<T extends z.ZodType>(item: T, name: string) {
  return z
    .object({
      items: z.array(item),
      total: z
        .number()
        .int()
        .min(0)
        .describe("Rows matching the query, not rows returned."),
      returned: z.number().int().min(0),
      truncated: z.boolean().describe("Whether rows exist beyond this page."),
    })
    .openapi(name);
}

export const PagedProjectSchema = pagedOf(ProjectSchema, "PagedProject");
export const PagedDocumentSchema = pagedOf(DocumentSchema, "PagedDocument");
export const PagedSectionSchema = pagedOf(
  SectionSchema,
  "PagedDocumentSection",
);
export const PagedAtomSchema = pagedOf(AtomSchema, "PagedAtom");

/**
 * Counts by status, for a project.
 *
 * An aggregate rather than a page, because the question is "how many" and
 * answering it by listing atoms is what put a cap in the wrong layer in the
 * first place. `awaitingRatification` is `provisional`, named separately
 * because it is the queue `docs/02-principles.md` (5) calls a first-class
 * product metric and the MCP `status` tool reports it under that name.
 */
export const AtomStatsSchema = z
  .object({
    provisional: z.number().int().min(0),
    canonical: z.number().int().min(0),
    rejected: z.number().int().min(0),
    superseded: z.number().int().min(0),
    awaitingRatification: z.number().int().min(0),
  })
  .openapi("AtomStats");

/**
 * The retrieval envelope, shared by `context` and `search`.
 *
 * `truncated` is mandatory and is never inferred from `returned < total`
 * (`docs/08-mcp-server.md`). `docs/06-retrieval.md` names four places something
 * can be dropped — a generator's cap, the fused list's cap, MMR against the
 * budget, and the HNSW traversal itself — and the flag is set by whichever
 * stage dropped it and propagated upward. By the time a boundary could compare
 * two counts, the information is gone.
 *
 * `skipped` is the other half of the same honesty. `docs/06-retrieval.md`
 * condition 5: a model call that is unavailable or over its deadline is
 * proceeded without, **visibly**. Silent degradation would leave two ranking
 * regimes in production that an evaluation cannot tell apart.
 */
const RetrievalEnvelope = {
  total: z
    .number()
    .int()
    .min(0)
    .describe(
      "Candidates that survived fusion — not atoms that could have matched, which is not a computable number.",
    ),
  returned: z.number().int().min(0),
  truncated: z
    .boolean()
    .describe("Set by the stage that dropped results, never inferred."),
  skipped: z
    .array(z.string())
    .describe(
      "Stages that did not run: 'dense' when the query was not embedded, 'reranker' when it was unavailable.",
    ),
};

export const PackedAtomSchema = z
  .object({
    atomId: z.uuid(),
    statement: z.string(),
    kind: z.enum(["constraint", "convention", "decision"]),
    provenance: z
      .string()
      .describe(
        "`document path#section`. The full quote is one read call away.",
      ),
  })
  .openapi("PackedAtom");

export const ContextRequestSchema = z
  .object({
    scope: z.enum(["file", "task", "project"]).default("task"),
    query: z.string().max(4000).nullish(),
    paths: z.array(z.string().max(1024)).max(64).default([]),
    documentId: z.uuid().nullish(),
    sectionId: z.uuid().nullish(),
    budgetTokens: z.number().int().min(0).max(200_000).default(2000),
  })
  .openapi("ContextRequest");

export const ContextResponseSchema = z
  .object({
    items: z.array(PackedAtomSchema),
    ...RetrievalEnvelope,
    budgetTokensUsed: z
      .number()
      .int()
      .min(0)
      .describe(
        "An upper bound on the pack's cost, not a measurement: there is no single true token count across the clients that read it.",
      ),
  })
  .openapi("ContextResponse");

export const SearchRequestSchema = z
  .object({
    query: z.string().min(1).max(4000),
    mode: z.enum(["lexical", "semantic", "hybrid"]).default("hybrid"),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .openapi("SearchRequest");

export const SearchHitSchema = z
  .object({
    atomId: z.uuid(),
    statement: z.string(),
    kind: z.enum(["constraint", "convention", "decision"]),
    documentId: z.uuid(),
    sectionId: z.uuid(),
    provenance: z.string(),
    score: z.number(),
  })
  .openapi("SearchHit");

export const SearchResponseSchema = z
  .object({
    items: z.array(SearchHitSchema),
    ...RetrievalEnvelope,
  })
  .openapi("SearchResponse");

/**
 * One outbound call, as a customer reads it.
 *
 * `docs/13-threat-model.md` (*Egress*, rule 3): a customer can ask what left,
 * to which provider, for which project, and an answer that requires reading
 * code — or a SQL prompt — is not good enough. This schema is that answer's
 * shape, and the shape is the review: it carries a size and never a sample.
 */
export const EgressEventSchema = z
  .object({
    // The purposes come from core rather than being written out again. They
    // were duplicated here, and the duplicate silently went stale the moment a
    // purpose was added — the wire would have described four kinds of outbound
    // call while the database could record five, and the one it omitted was the
    // read-path one a customer most wants to ask about.
    id: z.uuid(),
    projectId: z.uuid(),
    /** Null once the section it measured has been replaced by a re-push. */
    sectionId: z.uuid().nullable(),
    purpose: z.enum(EGRESS_PURPOSES),
    destination: z.string(),
    model: z.string(),
    inputItems: z.number().int().min(0),
    inputChars: z.number().int().min(0),
    at: z.iso.datetime(),
  })
  .openapi("EgressEvent");

/**
 * The same record grouped by the triple the allowlist pins.
 *
 * Grouped rather than summed, because a deployment that moved a pinned version
 * mid-quarter sent two different models and has to be able to say so.
 */
export const EgressSummarySchema = z
  .object({
    purpose: z.enum(EGRESS_PURPOSES),
    destination: z.string(),
    model: z.string(),
    calls: z.number().int().min(0),
    items: z.number().int().min(0),
    chars: z.number().int().min(0),
    firstAt: z.iso.datetime(),
    lastAt: z.iso.datetime(),
  })
  .openapi("EgressSummary");

export const PagedEgressEventSchema = pagedOf(
  EgressEventSchema,
  "PagedEgressEvent",
);

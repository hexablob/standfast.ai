import { z } from "@hono/zod-openapi";
import {
  ATOM_REJECT_REASONS,
  ATOM_STATUSES,
  DOCUMENT_BODY_MAX_CHARS,
  EGRESS_PURPOSES,
  FILE_PATH_MAX_CHARS,
  FINDING_STATUSES,
  FINDING_VERDICTS,
  isSubmittableFilePath,
  isSubmittableRationale,
  RATIONALE_MAX_CHARS,
  RECONCILIATION_TRIGGERS,
} from "@standfast/core";
import { PAGE_DEFAULT, PAGE_MAX } from "@standfast/db";

/**
 * Zod schemas are the single source: the OpenAPI document, the typed client
 * and the CLI are all derived from these, so a field that is absent here does
 * not exist anywhere downstream.
 */

export const UuidParam = z.uuid();

/**
 * A half-open range of Unicode code points: `start` inclusive, `end` exclusive.
 *
 * Declared once and shared, because the same shape is both accepted on
 * `CreateAtom` and returned on `Atom`, and two declarations of one range type
 * are two chances to disagree about whether `end` is inclusive.
 */
export const SpanSchema = z
  .object({
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .openapi("Span");

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
    // The bound lives in `packages/core` with the sectioner it protects, and
    // reaches the wire — and the OpenAPI artifact — from here. `app.ts` also
    // mounts a byte limit an order of magnitude above it, so this cap is what
    // a real client hits and that one is only ever the backstop.
    body: z.string().max(DOCUMENT_BODY_MAX_CHARS),
  })
  .openapi("PutDocument");

/**
 * One row of the sync manifest: identity, location and the hash to diff.
 *
 * No `body` and no `title`, and that is enforced by the repository's narrow
 * SELECT rather than by filtering a wider row — a field this schema does not
 * name never left the database at all.
 */
export const DocumentManifestEntrySchema = z
  .object({
    id: z.uuid(),
    path: z.string(),
    contentHash: z.string(),
  })
  .openapi("DocumentManifestEntry");

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
    status: z.enum(ATOM_STATUSES),
    sourceQuote: z.string(),
    /**
     * Where the quote sits inside its section, in Unicode **code points**.
     *
     * On the read surface because the ratification queue has to show a reviewer
     * the quote highlighted inside the section it came from, and a client given
     * only the quote text would have to search for it — which finds the wrong
     * occurrence the moment a section says the same sentence twice.
     *
     * Code points, not bytes. `packages/core/src/markdown.ts` counts them that
     * way deliberately, and a client that assumes bytes is wrong on any
     * document containing an em dash.
     */
    sourceSpan: SpanSchema,
    ratifiedBy: z.uuid().nullable(),
    ratifiedAt: z.iso.datetime().nullable(),
    supersededBy: z.uuid().nullable(),
    /**
     * Ratifier provenance for the export. Optional because only the list
     * route joins the ratifying actor in for the display name; null on any
     * row nobody has ratified.
     */
    ratifiedByKind: z.enum(["human", "agent"]).nullable().optional(),
    ratifiedByName: z.string().nullable().optional(),
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
    sourceSpan: SpanSchema,
  })
  .openapi("CreateAtom");

/**
 * A human's answer to a proposal, and the labelled corpus that falls out of it.
 *
 * Both fields optional, and that is load-bearing rather than lenient. A
 * required reason turns a decision into a form, and a reviewer made to justify
 * every rejection ratifies marginal atoms instead — the precise failure
 * `docs/15-ratification.md` is written against. The cheap decision has to stay
 * cheap or the queue stops draining.
 *
 * The vocabulary is closed because its whole value is comparability across
 * projects: `docs/12-evaluation.md` notes that ratification throughput is the
 * only one of the four numbers with no labelled corpus, because the human's
 * decision *is* the label. Given a reason, the same click labels extraction
 * precision and dedup recall for free.
 */
export const RejectAtomSchema = z
  .object({
    reason: z.enum(ATOM_REJECT_REASONS).optional(),
    /**
     * The free half. Capped at the same 280 characters as the reconciliation
     * rationale, so this system has one number for free text rather than two.
     *
     * No control-character rule, unlike that field. There the rule exists
     * because an *agent* writes the text and a human reads it — an instruction
     * channel. Here the human doing the rejecting writes it for their own
     * record. No agent is on this path, so there is no channel to close.
     */
    reasonNote: z.string().min(1).max(RATIONALE_MAX_CHARS).optional(),
  })
  .strict()
  .openapi("RejectAtom");

/**
 * Ratification, optionally replacing an incumbent.
 *
 * `supersedes` is a field rather than a fifth route because
 * `docs/15-ratification.md` treats replacing an atom as **one** decision. Two
 * routes would make the atomicity the caller's problem, and a half-applied
 * supersede leaves two canonical atoms making the same claim — the state the
 * whole deduplication pass exists to prevent.
 *
 * Carried as a query parameter, not a body. Ratification has always been a
 * bodyless `POST`, and clients that still send a JSON content type would make an
 * optional body a parse error — a 400 on the common path for the sake of a field
 * most callers never set. The route is unchanged in every other respect.
 */
export const RatifyAtomSchema = z
  .object({
    supersedes: UuidParam.optional(),
  })
  .strict()
  .openapi("RatifyAtom");

/**
 * One provisional atom, with everything the reviewer needs to decide on it.
 *
 * Wider than `AtomSchema` because a decision needs its provenance in the same
 * response: the section body the quote was lifted from, the path of the document
 * it lives in, and who proposed it. `docs/15-ratification.md` is explicit that a
 * reviewer who has to fetch the section separately will ratify without reading
 * it — which is the failure this whole queue exists to prevent.
 *
 * `sectionBody` is therefore whole and never truncated. It is the one string on
 * this surface a page limit must not touch; paginate the items instead.
 */
export const QueueItemSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["decision", "convention", "constraint"]),
    statement: z.string(),
    sourceQuote: z.string(),
    sourceSpan: SpanSchema,
    status: z.enum(ATOM_STATUSES),
    createdAt: z.iso.datetime(),
    /**
     * When the atom entered the queue, which is what FIFO orders on and what
     * the queue age is measured from — not `createdAt`, which a re-proposal
     * would not move.
     */
    proposedAt: z.iso.datetime(),
    proposedById: z.uuid().nullable(),
    proposedByKind: z.enum(["human", "agent"]).nullable(),
    proposedByName: z.string().nullable(),
    documentId: z.uuid(),
    documentPath: z.string(),
    sectionId: z.uuid(),
    sectionOrdinal: z.number().int(),
    sectionHeadingPath: z.array(z.string()),
    sectionBody: z.string().describe("The whole section. Never truncated."),
    /**
     * The canonical atom this candidate may replace — reading-order item 6 in
     * `docs/15-ratification.md`, computed at read time against the judge band
     * from `docs/05-extraction.md`. On the same response because `supersedes`
     * is offered only when an incumbent is on screen, and a second round trip
     * is how it stops being on screen. Null when the candidate has no
     * embedding or no canonical atom falls in the band: the reviewer is not
     * asked to go looking.
     */
    incumbent: z
      .object({
        id: z.uuid(),
        statement: z.string(),
        similarity: z.number(),
      })
      .nullable()
      .describe(
        "The canonical near neighbour from the dedup judge band, or null.",
      ),
  })
  .openapi("QueueItem");

/**
 * Phase 4 exit criterion 2: is the queue being worked, and is it draining?
 *
 * Backlog and queue age are the unfiltered numbers `queueStats` computes — they
 * ride here rather than on the queue route because that route serves a
 * *filtered* page, and a count next to a filtered list is a count somebody will
 * read as the list's. They also overlap `ratificationThroughput` by design:
 * `backlog` is the same number both ways round and `queueAgeSeconds` is the
 * largest entry in `backlogAgesSeconds`. Reported once, from one route.
 *
 * No field here carries a target. `docs/14-roadmap.md` leaves this metric's bar
 * unchosen and `docs/02-principles.md` (10) forbids inventing one, so the route
 * reports the distribution and the caller says what age they meant.
 */
export const RatificationSchema = z
  .object({
    backlog: z
      .number()
      .int()
      .min(0)
      .describe("Provisional atoms in the project. Never a filtered count."),
    oldestProposedAt: z.iso.datetime().nullable(),
    queueAgeSeconds: z.number().nullable(),
    decided: z
      .number()
      .int()
      .min(0)
      .describe("Atoms ratified, rejected or retired in the window."),
    medianSecondsToDecision: z
      .number()
      .nullable()
      .describe("Null when nothing was decided. Zero would be a lie."),
    backlogOlderThan: z.number().int().min(0),
    backlogShareOlderThan: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe("Null on an empty backlog: 0/0 is not 0."),
    backlogAgesSeconds: z
      .array(z.number())
      .describe(
        "Every provisional atom's age, ascending, so a caller can answer for any threshold without this route committing to one.",
      ),
  })
  .openapi("Ratification");

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
export const PagedDocumentManifestEntrySchema = pagedOf(
  DocumentManifestEntrySchema,
  "PagedDocumentManifestEntry",
);
export const PagedSectionSchema = pagedOf(
  SectionSchema,
  "PagedDocumentSection",
);
export const PagedAtomSchema = pagedOf(AtomSchema, "PagedAtom");
export const PagedQueueItemSchema = pagedOf(QueueItemSchema, "PagedQueueItem");

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
    retired: z.number().int().min(0),
    canonical: z.number().int().min(0),
    rejected: z.number().int().min(0),
    superseded: z.number().int().min(0),
    awaitingRatification: z.number().int().min(0),
    /**
     * Violations waiting on a human answer, and canonical atoms nobody has
     * checked since they were last ratified.
     *
     * They sit beside `awaitingRatification` because all three are counts of
     * things waiting on a person, which is the only queue this product has.
     *
     * **`honored` and `not_applicable` are deliberately not reported here, or
     * anywhere.** They are coverage and freshness, never findings. Rendering
     * them would invite a green tick, and a tick claims proof — `honored` is a
     * residual, what gets recorded when the search for a counter-example came
     * back empty. Nothing on this path proves an atom is honored.
     */
    openFindings: z.number().int().min(0),
    canonicalUnchecked: z.number().int().min(0),
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

/**
 * One verdict on one atom against one file.
 *
 * **This schema is a security control, not a convenience.** It is the boundary
 * where the third founding invariant — source code never leaves the customer's
 * machine — is enforced against an agent that has just finished reading source
 * and is being asked to say something about it. So it shares a type with
 * nothing, is never widened by inheritance, and is `.strict()`: a field nobody
 * listed is a 400 rather than a field silently dropped. That is the wire
 * allowlist's argument pointed in the other direction — the columns that do not
 * exist are the control, and so are the fields that are not accepted.
 *
 * `lineStart` and `lineEnd` are a pointer into a tree this server has never
 * seen. `rationale` is the one free-text field, and every rule core applies to
 * it is applied here too, because the database can enforce the length but not
 * the shape.
 */
export const ReconcileItemSchema = z
  .object({
    atomId: UuidParam,
    verdict: z.enum(FINDING_VERDICTS),
    filePath: z
      .string()
      .min(1)
      .max(FILE_PATH_MAX_CHARS)
      .refine(isSubmittableFilePath, {
        message:
          "filePath is a relative pointer: not absolute, and not climbing through '..'.",
      }),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    rationale: z
      .string()
      .max(RATIONALE_MAX_CHARS)
      .refine(isSubmittableRationale, {
        message:
          "rationale is one short line of prose. No control characters, so a pasted snippet cannot fit.",
      })
      .optional(),
  })
  .strict()
  // Principle 8, at the boundary as well as in the schema: a violation points
  // at the lines that disprove the atom, or it is not a violation. The database
  // refuses the row too — this is what makes the refusal a 400 with a sentence
  // rather than a 500 with a constraint name.
  .refine(
    (item) =>
      item.verdict !== "violated" ||
      (item.lineStart !== undefined && item.lineEnd !== undefined),
    {
      message: "A violated verdict must cite the lines that disprove the atom.",
      path: ["lineStart"],
    },
  )
  .refine(
    (item) => (item.lineStart === undefined) === (item.lineEnd === undefined),
    { message: "lineStart and lineEnd are given together.", path: ["lineEnd"] },
  )
  .refine(
    (item) =>
      item.lineEnd === undefined ||
      item.lineStart === undefined ||
      item.lineEnd >= item.lineStart,
    { message: "lineEnd is at or after lineStart.", path: ["lineEnd"] },
  )
  .openapi("ReconcileItem");

/**
 * One submission. One call, one run.
 *
 * The bound on `items` is a request bound — the same kind as the cap on
 * `context`'s `paths` — and deliberately *not* the cap on how many atoms should
 * be checked at once. `docs/07-reconciliation.md` leaves that one open and says
 * it is low and unmeasured, and a number invented here would be tuning on
 * nothing.
 */
export const ReconcileRequestSchema = z
  .object({
    // Self-reported, so analytics and never control. Nothing downstream
    // branches on it.
    trigger: z.enum(RECONCILIATION_TRIGGERS).default("agent"),
    items: z.array(ReconcileItemSchema).min(1).max(64),
  })
  .strict()
  .openapi("ReconcileRequest");

/**
 * What was recorded, and how much of it a human now has to answer.
 *
 * Three fields. An acknowledgement is not a list, so there is no envelope and
 * nothing to truncate.
 */
export const ReconcileAckSchema = z
  .object({
    runId: UuidParam,
    recorded: z.number().int().min(0),
    open: z.number().int().min(0),
  })
  .openapi("ReconcileAck");

/**
 * A finding, as served back.
 *
 * **`rationale` is deliberately absent**, and its absence is load-bearing. It is
 * written once and read by a human in the review surface; serialising it here
 * would make the one free-text field on this path readable by the next agent
 * that calls a list endpoint, which is precisely the instruction channel
 * `docs/02-principles.md` (13) is about. Appearing in `WIRE_ALLOWLIST` is the
 * record that a reviewer saw the column, never permission to serve it — the
 * same split as `atoms.embedding`.
 */
export const FindingSchema = z
  .object({
    id: UuidParam,
    projectId: UuidParam,
    runId: UuidParam,
    atomId: UuidParam,
    verdict: z.enum(FINDING_VERDICTS),
    filePath: z.string(),
    lineStart: z.number().int().nullable(),
    lineEnd: z.number().int().nullable(),
    status: z.enum(FINDING_STATUSES),
    resolvedBy: UuidParam.nullable(),
    resolvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Finding");

export const PagedFindingSchema = pagedOf(FindingSchema, "PagedFinding");

/**
 * A human's answer to one open finding.
 *
 * Two values, and neither of them reopens anything. `accepted` says the atom
 * was right and the code is wrong; `dismissed` says the finding was wrong — and
 * dismissals are the numerator of the kill metric, which is why nothing can
 * delete one.
 */
export const ResolveFindingSchema = z
  .object({
    status: z.enum(["accepted", "dismissed"]),
  })
  .strict()
  .openapi("ResolveFinding");

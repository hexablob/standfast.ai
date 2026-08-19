import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import {
  actorKind,
  atomEvent,
  atomKind,
  atomStatus,
  egressPurpose,
  extractionStatus,
} from "./enums.js";
import { orgIsolationPolicy } from "./rls.js";
import { actors, orgs } from "./tenancy.js";

/**
 * `int4range`. Drizzle has no builtin for Postgres range types, and the span
 * is not two loose integers: a range carries its own containment and overlap
 * operators, which is what verbatim-quote verification will need in phase 1.
 */
const int4range = customType<{ data: string; driverData: string }>({
  dataType: () => "int4range",
});

/**
 * `tsvector`. Drizzle has no builtin, and this one is never read in TypeScript:
 * it exists so the schema describes the column migration 0007 creates, and so
 * `drizzle-kit generate` does not propose adding it again.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("projects_org_slug_key").on(t.orgId, t.slug),
    orgIsolationPolicy("projects"),
  ],
).enableRLS();

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    title: text("title"),
    // Documents are the source; atoms are a projection of them. The body is
    // not optional and not stored elsewhere — invariant 1 would be
    // unenforceable if an atom could cite a document with no content.
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("documents_org_project_path_key").on(
      t.orgId,
      t.projectId,
      t.path,
    ),
    index("documents_project_id_idx").on(t.projectId),
    orgIsolationPolicy("documents"),
  ],
).enableRLS();

export const documentSections = pgTable(
  "document_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    headingPath: text("heading_path").array().notNull(),
    body: text("body").notNull(),
    // The unit of incremental extraction: a document edit re-extracts only
    // the sections whose hash moved. Phase 0 populates these; it does not
    // extract from them.
    sectionHash: text("section_hash").notNull(),
  },
  (t) => [
    // A UNIQUE *constraint*, not a unique index. `putDocument` reorders
    // sections in place, and moving one from ordinal 4 to ordinal 2 collides
    // with the row already at 2 partway through the statement. Postgres can
    // defer a constraint to commit time; it cannot defer an index. The
    // DEFERRABLE clause itself is hand-written in the migration — drizzle-kit
    // has no way to express it.
    unique("document_sections_document_ordinal_key").on(
      t.documentId,
      t.ordinal,
    ),

    // Redundant on its own — `id` is already the primary key — and that is
    // exactly its purpose: it gives the composite key on `atoms` something to
    // reference, which is what makes "this section belongs to this document"
    // checkable rather than assumed.
    unique("document_sections_document_id_id_key").on(t.documentId, t.id),

    index("document_sections_hash_idx").on(t.sectionHash),
    orgIsolationPolicy("document_sections"),
  ],
).enableRLS();

export const atoms = pgTable(
  "atoms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    // Invariant 1 — atoms are a projection of documents. Both are NOT NULL and
    // both cascade: an atom cannot be created without a section to cite, and
    // cannot outlive it.
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // Deliberately without a single-column reference. The composite key in the
    // constraint list below carries it, and carries more: a section id that
    // resolves on its own is not enough, it has to resolve *inside the document
    // this atom names*.
    sectionId: uuid("section_id").notNull(),

    statement: text("statement").notNull(),
    kind: atomKind("kind").notNull(),

    // Invariant 2 — born provisional.
    status: atomStatus("status").notNull().default("provisional"),

    // Provenance. NOT NULL plus a non-empty check, so it cannot be skipped
    // and cannot be satisfied with an empty string.
    sourceQuote: text("source_quote").notNull(),
    sourceSpan: int4range("source_span").notNull(),

    ratifiedBy: uuid("ratified_by"),
    ratifiedByKind: actorKind("ratified_by_kind"),
    ratifiedAt: timestamp("ratified_at", { withTimezone: true }),

    supersededBy: uuid("superseded_by"),

    // Deduplication in phase 1, and generator 1 from phase 2. Still not on
    // `AtomSchema`, so it never reaches the wire — retrieval reads it server
    // side to rank and to compute MMR's diversity term, and returns neither.
    // 1024 dimensions is settled independently of the provider — both
    // candidates emit 1024 — which is why this column landed before that
    // decision did. Nullable, because an atom exists the moment it is extracted
    // and is embedded a step later; `packages/core/src/mmr.ts` gives an atom
    // with no vector no diversity penalty rather than dropping it.
    //
    // Indexed by migration 0007. The HNSW parameters and the reason the choice
    // splits between build time and query time are documented there.
    embedding: vector("embedding", { dimensions: 1024 }),

    // Which extractor produced this atom, and — when null — that none did.
    //
    // The null is the load-bearing half. `propose` and the atoms endpoint let a
    // human or an agent write an atom directly, and re-projection has to tell
    // those apart from its own previous output: docs/05-extraction.md flags an
    // atom the new extractor no longer produces for human review, and computes
    // that by subtraction over the atoms citing the section. Without this
    // column the subtraction sweeps up everything a person wrote by hand and
    // reports it as extractor-abandoned, which is the inverse of the intent.
    //
    // Not a foreign key to `section_extractions`. That row is keyed by section
    // and is deleted when the section is; the atom's attribution has to survive
    // both. It is the same opaque string, compared as text.
    extractorVersion: text("extractor_version"),

    // Generator 2's index, maintained by Postgres rather than by us. Generated
    // and STORED, so no write path can forget it and it cannot drift from the
    // row it summarises. The regconfig is named because a generated column
    // needs an immutable expression, and the one-argument `to_tsvector` reads a
    // per-session setting. Migration 0007 is where it is created, and why it is
    // unweighted.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', "statement" || ' ' || "source_quote")`,
    ),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("atoms_document_id_idx").on(t.documentId),
    index("atoms_section_id_idx").on(t.sectionId),
    index("atoms_project_status_idx").on(t.projectId, t.status),

    // ─── Phase 2, the four generators (migration 0007) ───────────────────────
    //
    // Declared here so `drizzle-kit generate` sees no drift. The migration is
    // hand-written, because drizzle-kit emits none of these three.
    index("atoms_search_vector_idx").using("gin", t.searchVector),
    index("atoms_trigram_idx").using(
      "gin",
      sql`(${t.statement} || ' ' || ${t.sourceQuote}) gin_trgm_ops`,
    ),
    index("atoms_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("atoms_structural_idx")
      .using("btree", t.projectId, t.kind, sql`${t.createdAt} DESC`)
      .where(sql`status = 'canonical'`),
    index("atoms_superseded_by_idx")
      .using("btree", t.supersededBy)
      .where(sql`superseded_by IS NOT NULL`),

    // Invariant 1, closed. The single-column key this replaces let an atom name
    // document A and a section of document B: `read` would report provenance
    // that is half wrong, and the quote trigger would verify against the wrong
    // body and pass. Cascade is preserved — an atom still cannot outlive the
    // section it cites.
    foreignKey({
      columns: [t.documentId, t.sectionId],
      foreignColumns: [documentSections.documentId, documentSections.id],
      name: "atoms_document_section_fk",
    }).onDelete("cascade"),

    foreignKey({
      columns: [t.supersededBy],
      foreignColumns: [t.id],
      name: "atoms_superseded_by_fk",
    }),

    // The composite key that makes "an agent cannot promote its own
    // knowledge" a database constraint. `actors` is unique on (id, kind), so
    // a row naming an agent's id must also claim kind = 'agent' to satisfy
    // this foreign key — and then fails the check below.
    foreignKey({
      columns: [t.ratifiedBy, t.ratifiedByKind],
      foreignColumns: [actors.id, actors.kind],
      name: "atoms_ratified_by_human_fk",
    }),
    check("atoms_ratifier_is_human", sql`ratified_by_kind = 'human'`),

    check(
      "atoms_canonical_requires_ratification",
      sql`status <> 'canonical' OR (ratified_by IS NOT NULL AND ratified_at IS NOT NULL)`,
    ),
    check("atoms_source_quote_not_blank", sql`length(btrim(source_quote)) > 0`),

    // An atom cites something. `not null` accepts `'empty'`, which names no
    // characters at all; the quote trigger would then compare the empty string
    // against a non-blank quote and reject the row anyway, but it would reject
    // it for the wrong reason. Fail here, where the reason is legible.
    check("atoms_source_span_not_empty", sql`not isempty(source_span)`),

    orgIsolationPolicy("atoms"),
  ],
).enableRLS();

/**
 * Append-only. docs/02-principles.md (5) makes ratification throughput a
 * first-class product metric, and a metric nobody recorded cannot be computed
 * retroactively — so the log exists from the first migration rather than from
 * the first time someone asks how the queue is doing.
 */
export const atomEvents = pgTable(
  "atom_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    atomId: uuid("atom_id")
      .notNull()
      .references(() => atoms.id, { onDelete: "cascade" }),
    event: atomEvent("event").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("atom_events_atom_id_idx").on(t.atomId),
    index("atom_events_at_idx").on(t.at),
    orgIsolationPolicy("atom_events"),
  ],
).enableRLS();

/**
 * One row per (section, extractor version). This is what makes extraction
 * incremental and idempotent: the unique key means a second run over an
 * unchanged section with an unchanged extractor is a no-op the database
 * refuses, not a duplicate the worker has to notice.
 */
export const sectionExtractions = pgTable(
  "section_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => documentSections.id, { onDelete: "cascade" }),

    // Denormalised from document_sections -> documents. Every question anyone
    // asks about extraction is project-scoped — the `status` tool most of all,
    // which docs/05-extraction.md names as where a missing extraction surfaces
    // — and without this column each one is a three-hop join. atom_suppressions
    // already carries it for the same reason.
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    // One opaque string over the prompt version, the extraction model, the
    // embedding model, the dedup thresholds and the sectioning algorithm
    // version. Opaque because each of those changes the output, and splitting
    // it into components would only invite arguing about which components
    // count as a new version.
    extractorVersion: text("extractor_version").notNull(),

    // The hash as it stood when this run started. The section may have moved
    // since; comparing this against the row's current hash is how a stale
    // result is identified without calling a model to find out.
    sectionHash: text("section_hash").notNull(),

    status: extractionStatus("status").notNull().default("running"),
    error: text("error"),

    // What the model offered and what verification threw away.
    //
    // docs/05-extraction.md says a candidate whose quote does not appear in its
    // section is "dropped and counted", and until now there was nowhere to
    // count it. The drop rate is the raw material for the *unsupported* class
    // in docs/12-evaluation.md, which is a gate rather than a score — and like
    // every other count in this schema it cannot be reconstructed after the
    // fact, because the candidates that were dropped were never written down.
    //
    // Nullable: a row claimed but not yet finished has seen nothing.
    candidatesTotal: integer("candidates_total"),
    candidatesDropped: integer("candidates_dropped"),

    // Set, never inferred, for the same reason `truncated` is set on a context
    // pack: a cap that silently applies reads as a section that had nothing
    // more to say. Recorded here rather than at the queue, because the queue
    // cannot tell you which sections hit it.
    candidatesTruncated: boolean("candidates_truncated")
      .notNull()
      .default(false),

    // A retry at the same extractor_version has to reuse this row — the unique
    // key below leaves it no choice — so it overwrites started_at and error.
    // Without a counter the attempt history is gone, and a poison-job policy
    // has no evidence to be designed against.
    attempts: integer("attempts").notNull().default(0),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // How a crashed worker is told apart from a busy one. `status = 'running'`
    // alone cannot: both look identical, and guessing from the age of
    // started_at makes the answer a function of how long extraction happens to
    // take today. A lease that has expired is claimable by the conditional
    // update in the worker, which is what makes takeover a lock rather than a
    // race.
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),

    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("section_extractions_section_version_key").on(
      t.sectionId,
      t.extractorVersion,
    ),
    index("section_extractions_status_idx").on(t.status),
    index("section_extractions_project_id_idx").on(t.projectId),

    // A run is either still going or it has a finish time. Without this, a
    // worker killed mid-run and a worker that forgot to stamp the time are the
    // same row, and they need different repairs.
    check(
      "section_extractions_finished_iff_terminal",
      sql`(status = 'running') = (finished_at IS NULL)`,
    ),

    // A lease belongs to a run in progress. A terminal row holding one would
    // make the takeover query's WHERE clause depend on status alone, which is
    // the check it exists to avoid.
    check(
      "section_extractions_lease_iff_running",
      sql`(status = 'running') OR (lease_expires_at IS NULL)`,
    ),

    // Dropped candidates are a subset of the candidates seen. Both null while
    // the run is open; neither may be null once the other is set.
    check(
      "section_extractions_candidates_coherent",
      sql`(candidates_total IS NULL) = (candidates_dropped IS NULL)
          AND (candidates_dropped IS NULL OR candidates_dropped <= candidates_total)`,
    ),

    orgIsolationPolicy("section_extractions"),
  ],
).enableRLS();

/**
 * What deduplication threw away. Principle 10 asks for thresholds set against
 * evidence, and a threshold can only be moved with confidence by someone who
 * can see what the current one is discarding — so the discards are recorded
 * rather than dropped.
 */
export const atomSuppressions = pgTable(
  "atom_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => documentSections.id, { onDelete: "cascade" }),

    // The candidate as the extractor produced it. Kept verbatim: a suppressed
    // statement that has been normalised is no longer evidence about what the
    // extractor does.
    statement: text("statement").notNull(),
    reason: text("reason").notNull(),

    // Cosine *similarity*, `1 - (a <=> b)`, not the distance pgvector returns.
    // Storing the distance and comparing it against bands written as
    // similarities is the error this column name exists to prevent.
    similarity: doublePrecision("similarity"),

    // `set null`, not cascade: the record that something was suppressed has to
    // outlive the atom it duplicated, or re-extracting the winning section
    // erases the evidence for the losing one.
    duplicateOfAtomId: uuid("duplicate_of_atom_id").references(() => atoms.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("atom_suppressions_section_id_idx").on(t.sectionId),
    index("atom_suppressions_project_id_idx").on(t.projectId),

    // The orphans the `set null` above creates: suppressions whose winner is
    // gone. That is the population worth re-examining, and it is a small
    // fraction of the table, so the index is partial.
    index("atom_suppressions_orphaned_idx")
      .on(t.projectId, t.createdAt)
      .where(sql`duplicate_of_atom_id is null`),

    check("atom_suppressions_reason_not_blank", sql`length(btrim(reason)) > 0`),

    orgIsolationPolicy("atom_suppressions"),
  ],
).enableRLS();

/**
 * One row per outbound call: what left, to which provider, for which project.
 *
 * `docs/13-threat-model.md` (*Egress*, rule 3) says egress is disclosable, and
 * that if answering the question requires reading code the answer is not good
 * enough. `describeEgress` in core answers the static half — what a deployment
 * is *configured* to reach. This is the other half, and it is the one a
 * customer actually asks for.
 *
 * It records the shape of what left and never a copy of it. There is no column
 * that can hold prose: `input_chars` and `input_items` say how much and how
 * many, and that is the whole measurement. A disclosure log holding the text
 * it discloses would double the number of places that text exists, in a table
 * whose entire purpose is to be readable by whoever asks — which is the
 * opposite of what invariant 3 buys.
 *
 * Append-only, like `atom_events`, and for a stronger reason: the grant is
 * SELECT and INSERT, so `standfast_app` cannot revise the record of what it sent.
 *
 * The row is written **before** the call, not after. A row for a call that
 * failed to connect over-reports by one request; a row written afterwards
 * loses every call the process died during. Between over- and under-reporting
 * what left a customer's machine, only one of those errs in the customer's
 * favour.
 */
export const egressEvents = pgTable(
  "egress_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Set null rather than cascade. Ordinary document churn — a re-push that
    // replaces sections — must not quietly erase the record that their prose
    // was sent somewhere, and a null here still leaves the project, the
    // provider and the size intact.
    sectionId: uuid("section_id").references(() => documentSections.id, {
      onDelete: "set null",
    }),
    purpose: egressPurpose("purpose").notNull(),
    /** The origin, exactly as the allowlist entry admitted it. */
    destination: text("destination").notNull(),
    /** The pinned model version, exactly as the allowlist entry pinned it. */
    model: text("model").notNull(),
    /** How many pieces of prose went in one call. One section, or n statements. */
    inputItems: integer("input_items").notNull(),
    /** How much prose, in characters. Never the prose. */
    inputChars: integer("input_chars").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("egress_events_project_at_idx").on(t.projectId, t.at),
    check("egress_events_input_items_nonneg", sql`input_items >= 0`),
    check("egress_events_input_chars_nonneg", sql`input_chars >= 0`),
    check(
      "egress_events_destination_not_blank",
      sql`length(btrim(destination)) > 0`,
    ),
    check("egress_events_model_not_blank", sql`length(btrim(model)) > 0`),
    orgIsolationPolicy("egress_events"),
  ],
).enableRLS();

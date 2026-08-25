import { desc, sql } from "drizzle-orm";
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
  atomRejectReason,
  atomStatus,
  egressPurpose,
  extractionStatus,
  findingStatus,
  findingVerdict,
  reconciliationTrigger,
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
    // Redundant as uniqueness — `id` is the primary key — and declared because
    // Postgres will only accept a composite foreign key against a declared
    // unique pair. It lets a row elsewhere say "my project belongs to my org"
    // as a constraint, which row-level security cannot: RLS compares `org_id`
    // against the session GUC and never checks that the row's other keys agree
    // with it.
    unique("projects_id_org_key").on(t.id, t.orgId),
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
    projectId: uuid("project_id").notNull(),
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
    // Tenancy, as a constraint. RLS compares `org_id` to the session GUC and
    // never checks that this row's other keys point inside that same org.
    // Migration 0010 carries the argument.
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "documents_project_in_org_fk",
    }).onDelete("cascade"),
    unique("documents_id_org_key").on(t.id, t.orgId),
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
    documentId: uuid("document_id").notNull(),
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
    // Tenancy, as a constraint. RLS compares `org_id` to the session GUC and
    // never checks that this row's other keys point inside that same org.
    // Migration 0010 carries the argument.
    foreignKey({
      columns: [t.documentId, t.orgId],
      foreignColumns: [documents.id, documents.orgId],
      name: "document_sections_document_in_org_fk",
    }).onDelete("cascade"),
    unique("document_sections_id_org_key").on(t.id, t.orgId),
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
    projectId: uuid("project_id").notNull(),

    // Invariant 1 — atoms are a projection of documents. Both are NOT NULL and
    // both cascade: an atom cannot be created without a section to cite, and
    // cannot outlive it.
    documentId: uuid("document_id").notNull(),
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

    // Redundant as a uniqueness claim — `id` is already the primary key — and
    // declared anyway, because Postgres will only accept a composite foreign
    // key against a declared unique pair. `reconciliation_findings` needs it to
    // say "this finding's atom belongs to this finding's project" as a
    // constraint. Exactly the trick `document_sections` plays for the key
    // above, and `actors (id, kind)` plays for ratification.
    unique("atoms_id_project_key").on(t.id, t.projectId),

    foreignKey({
      columns: [t.supersededBy],
      foreignColumns: [t.id],
      name: "atoms_superseded_by_fk",
    }),

    // Tenancy, as constraints. RLS compares `org_id` to the session GUC and
    // never checks that a row's other keys point inside that same org, so
    // without these an atom could name another tenant's project, document or
    // superseding atom and still pass every policy. Migration 0010 carries the
    // argument; it repeats for every org-scoped table.
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "atoms_project_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.documentId, t.orgId],
      foreignColumns: [documents.id, documents.orgId],
      name: "atoms_document_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.supersededBy, t.orgId],
      foreignColumns: [t.id, t.orgId],
      name: "atoms_superseded_by_in_org_fk",
    }),
    foreignKey({
      columns: [t.ratifiedBy, t.orgId],
      foreignColumns: [actors.id, actors.orgId],
      name: "atoms_ratified_by_in_org_fk",
    }),
    unique("atoms_id_org_key").on(t.id, t.orgId),

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
    atomId: uuid("atom_id").notNull(),
    event: atomEvent("event").notNull(),
    actorId: uuid("actor_id").notNull(),
    /**
     * What kind of actor wrote this event — and the reason "only a human
     * decides" is a guarantee here rather than a habit.
     *
     * Filled by a `BEFORE INSERT` trigger from `actors`, never by the caller: a
     * column a writer can set is a column a writer can get wrong, and getting it
     * wrong is the whole attack. Migration 0013 carries the argument.
     *
     * `atoms.ratified_by_kind` has guarded ratification since 0000. This column
     * is the same trick applied to the ledger, which had no equivalent — a
     * rejection writes no `*_by_kind`, so nothing in the schema could refuse an
     * agent writing `rejected` or `retired` until this existed.
     *
     * **Declared nullable here and `NOT NULL` in the database, deliberately.**
     * The application never supplies it, so requiring it on insert would force
     * every call site to look up a kind the trigger is about to overwrite. The
     * looser type is the honest description of what a caller may provide, not a
     * disagreement about what the column holds.
     *
     * Worth knowing: the guarantee does not rest on the trigger. To write a
     * decision event you need `actor_kind = 'human'` (the check), and the
     * composite key then requires `(actor_id, 'human')` to exist in `actors`.
     * An agent cannot satisfy both, whatever it sends. The trigger exists so
     * that honest callers never have to think about the column at all.
     */
    actorKind: actorKind("actor_kind"),
    /**
     * Why a human rejected. Optional on purpose — a required field turns a
     * decision into a form, and a reviewer made to justify a rejection ratifies
     * marginal atoms instead.
     */
    reason: atomRejectReason("reason"),
    /**
     * The free half of the pair, capped at the same 280 characters as the
     * reconciliation rationale so the two free-text fields in this system live
     * under one number.
     *
     * It carries no control-character rule, unlike that one. The rule there
     * exists because an *agent* writes the rationale and a human reads it —
     * an instruction channel. This note is written by the human doing the
     * rejecting. There is no agent on this path and so no channel to close.
     */
    reasonNote: text("reason_note"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Tenancy, as a constraint. RLS compares `org_id` to the session GUC and
    // never checks that this row's other keys point inside that same org.
    // Migration 0010 carries the argument.
    foreignKey({
      columns: [t.atomId, t.orgId],
      foreignColumns: [atoms.id, atoms.orgId],
      name: "atom_events_atom_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.actorId, t.orgId],
      foreignColumns: [actors.id, actors.orgId],
      name: "atom_events_actor_in_org_fk",
    }),
    // A reason on `proposed` or `ratified` means nothing. This is what stops it
    // meaning something later by accident.
    check(
      "atom_events_reason_only_on_reject",
      sql`(reason is null and reason_note is null) or event = 'rejected'`,
    ),
    foreignKey({
      columns: [t.actorId, t.actorKind],
      foreignColumns: [actors.id, actors.kind],
      name: "atom_events_actor_kind_fk",
    }),
    // `proposed` is the one event an agent may write — that is what `propose`
    // and the extractor are for. Every other event is a decision, and decisions
    // are human. `superseded` is covered too, which matters: it is written on
    // the incumbent during a ratify-with-supersede and nothing else guarded it.
    check(
      "atom_events_decision_is_human",
      sql`event = 'proposed' or actor_kind = 'human'`,
    ),
    check(
      "atom_events_reason_note_shape",
      sql`reason_note is null or (length(btrim(reason_note)) > 0 and length(reason_note) <= 280)`,
    ),
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
    sectionId: uuid("section_id").notNull(),

    // Denormalised from document_sections -> documents. Every question anyone
    // asks about extraction is project-scoped — the `status` tool most of all,
    // which docs/05-extraction.md names as where a missing extraction surfaces
    // — and without this column each one is a three-hop join. atom_suppressions
    // already carries it for the same reason.
    projectId: uuid("project_id").notNull(),

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
    // Tenancy, as a constraint. RLS compares `org_id` to the session GUC and
    // never checks that this row's other keys point inside that same org.
    // Migration 0010 carries the argument.
    foreignKey({
      columns: [t.sectionId, t.orgId],
      foreignColumns: [documentSections.id, documentSections.orgId],
      name: "section_extractions_section_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "section_extractions_project_in_org_fk",
    }).onDelete("cascade"),
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
    projectId: uuid("project_id").notNull(),
    sectionId: uuid("section_id").notNull(),

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
    duplicateOfAtomId: uuid("duplicate_of_atom_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Tenancy, as a constraint. RLS compares `org_id` to the session GUC and
    // never checks that this row's other keys point inside that same org.
    // Migration 0010 carries the argument.
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "atom_suppressions_project_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.sectionId, t.orgId],
      foreignColumns: [documentSections.id, documentSections.orgId],
      name: "atom_suppressions_section_in_org_fk",
    }).onDelete("cascade"),
    // The migration nulls only the pointer on delete, never `org_id`, which is
    // NOT NULL — Postgres's `ON DELETE SET NULL (column)` form, which Drizzle
    // cannot express. The migration is authoritative for that detail.
    foreignKey({
      columns: [t.duplicateOfAtomId, t.orgId],
      foreignColumns: [atoms.id, atoms.orgId],
      name: "atom_suppressions_duplicate_of_in_org_fk",
    }),
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
    projectId: uuid("project_id").notNull(),
    // Set null rather than cascade. Ordinary document churn — a re-push that
    // replaces sections — must not quietly erase the record that their prose
    // was sent somewhere, and a null here still leaves the project, the
    // provider and the size intact.
    sectionId: uuid("section_id"),
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
    // Tenancy, as a constraint. RLS compares `org_id` to the session GUC and
    // never checks that this row's other keys point inside that same org.
    // Migration 0010 carries the argument.
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "egress_events_project_in_org_fk",
    }).onDelete("cascade"),
    // As above, the migration nulls only `section_id`, so the disclosure log
    // keeps its row when the section it described goes away.
    foreignKey({
      columns: [t.sectionId, t.orgId],
      foreignColumns: [documentSections.id, documentSections.orgId],
      name: "egress_events_section_in_org_fk",
    }),
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

/**
 * One submission of verdicts. One `reconcile` call, one row.
 *
 * `docs/07-reconciliation.md` (*The tables phase 3 adds*). It exists for three
 * things a finding row cannot carry: which loop produced this work, which actor
 * performed it, and the grouping that makes "twelve atoms checked, one
 * violation" a query rather than an inference.
 *
 * **The denominator lives here.** `verdict_count` makes checks-performed
 * countable without scanning findings, and without it the false-positive rate —
 * the kill metric for this whole phase — has a numerator and nothing to divide
 * it by.
 *
 * `actor_id` does not cascade. An actor is not deleted in this system, and a
 * run whose performer vanished would be a check nobody did.
 */
export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    trigger: reconciliationTrigger("trigger").notNull(),
    verdictCount: integer("verdict_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.actorId, t.orgId],
      foreignColumns: [actors.id, actors.orgId],
      name: "reconciliation_runs_actor_in_org_fk",
    }),
    // `org_id` and `project_id` must name the same tenant. RLS compares `org_id`
    // alone, so a pair of single-column keys would let this row claim a project
    // belonging to somebody else and still pass every check.
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "reconciliation_runs_project_in_org_fk",
    }).onDelete("cascade"),
    unique("reconciliation_runs_id_org_key").on(t.id, t.orgId),
    index("reconciliation_runs_project_created_idx").on(
      t.projectId,
      t.createdAt,
    ),
    check("reconciliation_runs_verdict_count_nonneg", sql`verdict_count >= 0`),
    orgIsolationPolicy("reconciliation_runs"),
  ],
).enableRLS();

/**
 * One verdict on one atom against one file. A verdict and a pointer, nothing
 * else.
 *
 * This is the table the third founding invariant is defended on: no column here
 * can hold a line of source. `file_path`, `line_start` and `line_end` are a
 * pointer into a tree the server has never seen, and `rationale` is the single
 * free-text field on the entire reconciliation path — capped, single-line, and
 * validated harder than anything else in the schema. Whether a cap is *enough*,
 * or whether free text has no place here at all, is still open in
 * `docs/13-threat-model.md`; these controls narrow the hole, they do not close
 * it.
 *
 * Three of the constraints below are each doing the work of a paragraph of
 * documentation, which is deliberate — `docs/04-data-model.md`: a constraint
 * that lives only in application code is a convention with better marketing.
 *
 * - **The citable-line check** puts falsification in the schema. A violation
 *   without a line that disproves the atom is unrepresentable.
 * - **The biconditional on `status`** means a non-violation can never appear in
 *   a human's queue and a violation can never be filed outside it. Without it,
 *   the queue is whatever the writer of the day remembered to set.
 * - **The composite ratifier key, reused.** An agent dismissing a finding about
 *   its own edit would be the reconciliation-shaped version of promoting its
 *   own knowledge, and `actors (id, kind)` already exists to refuse it.
 */
export const reconciliationFindings = pgTable(
  "reconciliation_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull(),
    atomId: uuid("atom_id").notNull(),

    verdict: findingVerdict("verdict").notNull(),
    filePath: text("file_path").notNull(),
    lineStart: integer("line_start"),
    lineEnd: integer("line_end"),
    /**
     * The one free-text field on this path. Never returned to another agent,
     * never indexed, never embedded, and served by no MCP tool.
     */
    rationale: text("rationale"),

    status: findingStatus("status").notNull(),
    resolvedBy: uuid("resolved_by"),
    resolvedByKind: actorKind("resolved_by_kind"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.resolvedBy, t.resolvedByKind],
      foreignColumns: [actors.id, actors.kind],
      name: "reconciliation_findings_resolver_fk",
    }),
    // A finding names an atom in its own project, as a constraint rather than a
    // code path. Referential-integrity triggers run with `row_security = off`,
    // so a single-column reference to `atoms(id)` is satisfied by an atom in
    // another project — or another org — without RLS ever seeing it, and
    // `countDrift` would then report another project's atom as checked.
    foreignKey({
      columns: [t.atomId, t.projectId],
      foreignColumns: [atoms.id, atoms.projectId],
      name: "reconciliation_findings_atom_in_project_fk",
    }).onDelete("cascade"),
    // The project must belong to this row's org, and the run must too. With the
    // atom key above, the whole row is pinned to one tenant by constraint
    // rather than by the route that happened to write it.
    foreignKey({
      columns: [t.projectId, t.orgId],
      foreignColumns: [projects.id, projects.orgId],
      name: "reconciliation_findings_project_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.runId, t.orgId],
      foreignColumns: [reconciliationRuns.id, reconciliationRuns.orgId],
      name: "reconciliation_findings_run_in_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.resolvedBy, t.orgId],
      foreignColumns: [actors.id, actors.orgId],
      name: "reconciliation_findings_resolved_by_in_org_fk",
    }),
    index("reconciliation_findings_project_status_idx").on(
      t.projectId,
      t.status,
    ),
    index("reconciliation_findings_atom_created_idx").on(
      t.atomId,
      desc(t.createdAt),
    ),
    index("reconciliation_findings_project_path_idx").on(
      t.projectId,
      t.filePath,
    ),
    index("reconciliation_findings_run_idx").on(t.runId),

    // Principle 8 as a constraint: a violation without a citable line is
    // unrepresentable.
    check(
      "reconciliation_findings_violation_cites_lines",
      sql`verdict <> 'violated' or (line_start is not null and line_end is not null)`,
    ),
    check(
      "reconciliation_findings_line_start_positive",
      sql`line_start is null or line_start >= 1`,
    ),
    check(
      "reconciliation_findings_line_end_ordered",
      sql`line_end is null or line_end >= line_start`,
    ),

    // Exactly the violations enter the human queue, and every violation does.
    check(
      "reconciliation_findings_queue_biconditional",
      sql`(verdict = 'violated') = (status <> 'recorded')`,
    ),

    // An agent cannot dismiss a finding about its own edit. Same mechanism as
    // ratification: `actors` is unique on (id, kind), so a row naming an
    // agent's id must claim kind = 'agent' to satisfy the key, and then fails
    // this check.
    check(
      "reconciliation_findings_resolver_is_human",
      sql`resolved_by_kind = 'human'`,
    ),
    // `resolved_by_kind` is in this list deliberately. A CHECK fails only on
    // FALSE, so `resolved_by_kind = 'human'` *passes* when the column is NULL,
    // and the composite resolver key above is MATCH SIMPLE, which Postgres
    // skips entirely when any referencing column is NULL. Leave the kind
    // nullable on a resolved row and both guards evaporate at once, leaving
    // "only a human resolves a finding" enforced by application code alone.
    check(
      "reconciliation_findings_resolution_complete",
      sql`status in ('recorded', 'open') or (resolved_by is not null and resolved_by_kind is not null and resolved_at is not null)`,
    ),

    check(
      "reconciliation_findings_rationale_capped",
      sql`rationale is null or length(rationale) <= 280`,
    ),

    // A backstop, not validation: the server has no file tree to check against.
    // What it can refuse is a path shaped like an escape.
    check(
      "reconciliation_findings_file_path_is_a_pointer",
      // The doubled backslashes matter: this is a template literal, so `\\.`
      // is what reaches Postgres as `\.`. Written `\.` the escape is consumed
      // here and the pattern degrades to `(^|/)..(/|$)`, which matches any
      // two-character path segment — `src/db/x.ts` would be refused.
      // The control-character clause is what stops this column becoming a
      // second free-text field. It is 1024 characters and, unlike `rationale`,
      // it is served back out — so without it an agent could put a newline and
      // forty lines of source here and have the server store and echo them.
      sql`file_path <> '' and length(file_path) <= 1024 and file_path !~ '^/' and file_path !~ '(^|/)\\.\\.(/|$)' and file_path !~ '[[:cntrl:]]'`,
    ),
    orgIsolationPolicy("reconciliation_findings"),
  ],
).enableRLS();

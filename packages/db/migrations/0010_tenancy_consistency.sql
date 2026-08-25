-- Every org-scoped row must agree with itself about which tenant it belongs to.
--
-- `docs/04-data-model.md` (*Tenancy consistency, and what row-level security
-- does not do*) states the gap this closes. Row-level security compares a row's
-- `org_id` against `standfast.org_id` and stops there. It does **not** check
-- that the row's foreign keys point at rows in that same org. So a row could
-- name this tenant in `org_id`, name another tenant's project in `project_id`,
-- satisfy every single-column foreign key, and pass every policy.
--
-- The other tenant never sees such a row — RLS filters it out on the way back —
-- so this is not a read leak, and it is not reachable through any route in the
-- API, all of which take both ids from the authenticated context. What it is:
-- a row that exists at all, that lists under another tenant's id for whoever
-- wrote it, and whose insert succeeding or failing answers a question about
-- another tenant's data. `docs/04-data-model.md` is explicit that a constraint
-- living only in application code is a convention with better marketing, and
-- "the route always passes the right org" was exactly that.
--
-- Migration 0009 closed this for the two tables phase 3 added and recorded the
-- rest as a known gap. This is the rest.
--
-- **The mechanism, once, since it repeats seventeen times below.** Declare the
-- pair `(id, org_id)` unique on the parent — redundant as uniqueness, because
-- `id` is already the primary key, and required because Postgres will only
-- accept a composite foreign key against a declared unique pair. Then replace
-- each single-column key with the pair. Same trick as `actors (id, kind)` for
-- ratification, pointed at tenancy instead of authority.
--
-- **Delete semantics are preserved exactly.** Every replacement below carries
-- the same `ON DELETE` action the key it replaces carried; this migration
-- changes what is *representable*, never what happens when a parent goes away.
-- The two `SET NULL` keys use Postgres 15's column-list form —
-- `ON DELETE SET NULL (column)` — because nulling the whole composite would try
-- to null `org_id`, which is `NOT NULL`, and turn a delete into an error.
--
-- **Nullable pointers stay optional.** These keys are MATCH SIMPLE, so a NULL
-- in the referencing column skips the check entirely. `superseded_by`,
-- `duplicate_of_atom_id`, `egress_events.section_id`, `ratified_by` and
-- `resolved_by` are all still free to be absent.
--
-- **On an existing deployment this migration fails if any row is already
-- inconsistent, and that is the correct behaviour.** There is no data to
-- migrate here, but a deployment that had such a row should stop and be looked
-- at rather than have the row quietly deleted or rewritten.

-- ── the unique pairs the composite keys reference ─────────────────────────
--
-- `projects (id, org_id)` already exists; migration 0009 added it.
ALTER TABLE "actors" ADD CONSTRAINT "actors_id_org_key" UNIQUE ("id","org_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_id_org_key" UNIQUE ("id","org_id");--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_id_org_key" UNIQUE ("id","org_id");--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_id_org_key" UNIQUE ("id","org_id");--> statement-breakpoint

-- ── projects ──────────────────────────────────────────────────────────────
ALTER TABLE "documents" DROP CONSTRAINT "documents_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atoms" DROP CONSTRAINT "atoms_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_suppressions" DROP CONSTRAINT "atom_suppressions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "atom_suppressions" ADD CONSTRAINT "atom_suppressions_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "section_extractions" DROP CONSTRAINT "section_extractions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "section_extractions" ADD CONSTRAINT "section_extractions_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "egress_events" DROP CONSTRAINT "egress_events_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "egress_events" ADD CONSTRAINT "egress_events_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── documents ─────────────────────────────────────────────────────────────
--
-- `atoms` already carries a composite key to `(document_id, section_id)`, which
-- closes "an atom naming document A and a section of document B". This closes
-- the other half: an atom naming a document in another org entirely.
ALTER TABLE "document_sections" DROP CONSTRAINT "document_sections_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_in_org_fk" FOREIGN KEY ("document_id","org_id") REFERENCES "public"."documents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atoms" DROP CONSTRAINT "atoms_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_document_in_org_fk" FOREIGN KEY ("document_id","org_id") REFERENCES "public"."documents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── document sections ─────────────────────────────────────────────────────
ALTER TABLE "section_extractions" DROP CONSTRAINT "section_extractions_section_id_document_sections_id_fk";--> statement-breakpoint
ALTER TABLE "section_extractions" ADD CONSTRAINT "section_extractions_section_in_org_fk" FOREIGN KEY ("section_id","org_id") REFERENCES "public"."document_sections"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_suppressions" DROP CONSTRAINT "atom_suppressions_section_id_document_sections_id_fk";--> statement-breakpoint
ALTER TABLE "atom_suppressions" ADD CONSTRAINT "atom_suppressions_section_in_org_fk" FOREIGN KEY ("section_id","org_id") REFERENCES "public"."document_sections"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The disclosure log keeps its row when the section it described goes away —
-- that is the point of an append-only log — so this one nulls the pointer
-- rather than cascading, and nulls only the pointer.
ALTER TABLE "egress_events" DROP CONSTRAINT "egress_events_section_id_document_sections_id_fk";--> statement-breakpoint
ALTER TABLE "egress_events" ADD CONSTRAINT "egress_events_section_in_org_fk" FOREIGN KEY ("section_id","org_id") REFERENCES "public"."document_sections"("id","org_id") ON DELETE SET NULL ("section_id") ON UPDATE no action;--> statement-breakpoint

-- ── atoms ─────────────────────────────────────────────────────────────────
ALTER TABLE "atom_events" DROP CONSTRAINT "atom_events_atom_id_atoms_id_fk";--> statement-breakpoint
ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_atom_in_org_fk" FOREIGN KEY ("atom_id","org_id") REFERENCES "public"."atoms"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Self-referencing: a superseding atom must be in the same org as the atom it
-- supersedes. Without this, one tenant's atom could be recorded as superseded
-- by another tenant's.
ALTER TABLE "atoms" DROP CONSTRAINT "atoms_superseded_by_fk";--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_superseded_by_in_org_fk" FOREIGN KEY ("superseded_by","org_id") REFERENCES "public"."atoms"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_suppressions" DROP CONSTRAINT "atom_suppressions_duplicate_of_atom_id_atoms_id_fk";--> statement-breakpoint
ALTER TABLE "atom_suppressions" ADD CONSTRAINT "atom_suppressions_duplicate_of_in_org_fk" FOREIGN KEY ("duplicate_of_atom_id","org_id") REFERENCES "public"."atoms"("id","org_id") ON DELETE SET NULL ("duplicate_of_atom_id") ON UPDATE no action;--> statement-breakpoint

-- ── actors ────────────────────────────────────────────────────────────────
--
-- `ratified_by` and `resolved_by` keep their composite keys to
-- `actors (id, kind)`, which is what refuses an agent promoting its own
-- knowledge. These are additional keys on the same columns, and they answer a
-- different question: not "is this actor a human" but "is this actor ours".
-- Both need answering, so both keys exist.
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_actor_in_org_fk" FOREIGN KEY ("actor_id","org_id") REFERENCES "public"."actors"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_events" DROP CONSTRAINT "atom_events_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_actor_in_org_fk" FOREIGN KEY ("actor_id","org_id") REFERENCES "public"."actors"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "reconciliation_runs" DROP CONSTRAINT "reconciliation_runs_actor_id_actors_id_fk";--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_actor_in_org_fk" FOREIGN KEY ("actor_id","org_id") REFERENCES "public"."actors"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atoms" ADD CONSTRAINT "atoms_ratified_by_in_org_fk" FOREIGN KEY ("ratified_by","org_id") REFERENCES "public"."actors"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_resolved_by_in_org_fk" FOREIGN KEY ("resolved_by","org_id") REFERENCES "public"."actors"("id","org_id") ON DELETE no action ON UPDATE no action;

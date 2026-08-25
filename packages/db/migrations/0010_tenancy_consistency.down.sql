-- Reverses 0010_tenancy_consistency.sql.
--
-- What this costs: every row goes back to being able to disagree with itself
-- about which tenant it belongs to. Row-level security still filters reads by
-- `org_id`, so nothing becomes visible across the boundary — but a row naming
-- this org and another org's project becomes representable again, and whether
-- writing one succeeds becomes an oracle about another tenant's data.
--
-- Order matters and is the mirror of the up: drop every composite key first,
-- restore the single-column keys it replaced, and only then drop the unique
-- pairs those composites referenced. Dropping a unique constraint while a
-- foreign key still points at it fails, which is what makes this order the one
-- that works rather than a preference.
--
-- The restored keys carry the same `ON DELETE` actions they had before 0010,
-- including the two `SET NULL`s — which on a single-column key need no column
-- list, because the column is the whole key.

-- ── restore the single-column keys ────────────────────────────────────────
ALTER TABLE "reconciliation_findings" DROP CONSTRAINT IF EXISTS "reconciliation_findings_resolved_by_in_org_fk";--> statement-breakpoint
ALTER TABLE "atoms" DROP CONSTRAINT IF EXISTS "atoms_ratified_by_in_org_fk";--> statement-breakpoint

ALTER TABLE "reconciliation_runs" DROP CONSTRAINT IF EXISTS "reconciliation_runs_actor_in_org_fk";--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_events" DROP CONSTRAINT IF EXISTS "atom_events_actor_in_org_fk";--> statement-breakpoint
ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_actor_in_org_fk";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_suppressions" DROP CONSTRAINT IF EXISTS "atom_suppressions_duplicate_of_in_org_fk";--> statement-breakpoint
ALTER TABLE "atom_suppressions" ADD CONSTRAINT "atom_suppressions_duplicate_of_atom_id_atoms_id_fk" FOREIGN KEY ("duplicate_of_atom_id") REFERENCES "public"."atoms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atoms" DROP CONSTRAINT IF EXISTS "atoms_superseded_by_in_org_fk";--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."atoms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_events" DROP CONSTRAINT IF EXISTS "atom_events_atom_in_org_fk";--> statement-breakpoint
ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_atom_id_atoms_id_fk" FOREIGN KEY ("atom_id") REFERENCES "public"."atoms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "egress_events" DROP CONSTRAINT IF EXISTS "egress_events_section_in_org_fk";--> statement-breakpoint
ALTER TABLE "egress_events" ADD CONSTRAINT "egress_events_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_suppressions" DROP CONSTRAINT IF EXISTS "atom_suppressions_section_in_org_fk";--> statement-breakpoint
ALTER TABLE "atom_suppressions" ADD CONSTRAINT "atom_suppressions_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "section_extractions" DROP CONSTRAINT IF EXISTS "section_extractions_section_in_org_fk";--> statement-breakpoint
ALTER TABLE "section_extractions" ADD CONSTRAINT "section_extractions_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atoms" DROP CONSTRAINT IF EXISTS "atoms_document_in_org_fk";--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "document_sections" DROP CONSTRAINT IF EXISTS "document_sections_document_in_org_fk";--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "egress_events" DROP CONSTRAINT IF EXISTS "egress_events_project_in_org_fk";--> statement-breakpoint
ALTER TABLE "egress_events" ADD CONSTRAINT "egress_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "section_extractions" DROP CONSTRAINT IF EXISTS "section_extractions_project_in_org_fk";--> statement-breakpoint
ALTER TABLE "section_extractions" ADD CONSTRAINT "section_extractions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atom_suppressions" DROP CONSTRAINT IF EXISTS "atom_suppressions_project_in_org_fk";--> statement-breakpoint
ALTER TABLE "atom_suppressions" ADD CONSTRAINT "atom_suppressions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "atoms" DROP CONSTRAINT IF EXISTS "atoms_project_in_org_fk";--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_project_in_org_fk";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── the unique pairs, last, once nothing references them ──────────────────
ALTER TABLE "atoms" DROP CONSTRAINT IF EXISTS "atoms_id_org_key";--> statement-breakpoint
ALTER TABLE "document_sections" DROP CONSTRAINT IF EXISTS "document_sections_id_org_key";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_id_org_key";--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT IF EXISTS "actors_id_org_key";

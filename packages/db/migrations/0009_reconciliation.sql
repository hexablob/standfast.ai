-- Phase 3. The two tables that record whether the code still honors an atom.
--
-- `docs/07-reconciliation.md` (*The tables phase 3 adds*) settles every column
-- and every constraint below. `docs/02-principles.md` (1) is why the phase
-- exists at all: keeping a record of decisions is trivial, and knowing whether
-- the code still honors them is the part nobody has.
--
-- **Written by hand, like 0007 and 0008.** drizzle-kit's snapshot chain stops
-- at 0006, so `db:generate` diffs against a four-migration-old picture of the
-- schema and emits changes that already shipped. `schema-guards.integration.test.ts`
-- is what keeps this file and the Drizzle declarations in
-- `packages/db/src/schema/knowledge.ts` in step, and it does two comparisons
-- against a live database rather than one: `WIRE_ALLOWLIST` against
-- `information_schema`, which catches a column nobody put in the allowlist, and
-- the Drizzle table objects against it column by column, which catches a column
-- added here and to the allowlist but forgotten in the model. The second was
-- added because this header once claimed it existed when it did not.
--
-- What is *not* here is the point of the table. There is no column for a
-- snippet, a diff, an excerpt, a content hash, or anything else derived from
-- the bytes of a file. A finding is a verdict and a pointer into a tree this
-- server has never seen. The third founding invariant — source code never
-- leaves the customer's machine — is defended here by the columns that do not
-- exist, and `packages/db/src/schema/wire-allowlist.ts` is where a reviewer is
-- forced to notice if one ever does.
CREATE TYPE "public"."reconciliation_trigger" AS ENUM('post_edit', 'session_end', 'explicit', 'agent', 'atom_ratified', 'stale');--> statement-breakpoint
CREATE TYPE "public"."finding_verdict" AS ENUM('honored', 'violated', 'not_applicable', 'unverifiable');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('recorded', 'open', 'accepted', 'dismissed');--> statement-breakpoint

-- One submission, one run. It carries the three things a finding row cannot:
-- which loop produced this work, which actor performed it, and the grouping
-- that makes "twelve atoms checked, one violation" a query rather than an
-- inference.
--
-- `verdict_count` is the denominator of the kill metric. Without it the
-- false-positive rate has a numerator and nothing to divide it by.
--
-- `trigger` is self-reported by the client and is therefore analytics, never
-- control. Nothing gates on it and no policy reads it.
--
-- `actor_id` does not cascade: a run whose performer vanished would be a check
-- nobody did.
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"trigger" "reconciliation_trigger" NOT NULL,
	"verdict_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_runs_verdict_count_nonneg" CHECK (verdict_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- One verdict on one atom against one file.
--
-- Three of these constraints are each doing the work of a paragraph of
-- documentation, and that is deliberate — `docs/04-data-model.md`: a constraint
-- that lives only in application code is a convention with better marketing.
--
--   * The citable-line check puts falsification in the schema. A violation
--     without a line that disproves the atom is unrepresentable.
--   * The biconditional on `status` means a non-violation can never appear in a
--     human's queue and a violation can never be filed outside it. Without it
--     the queue is whatever the writer of the day remembered to set.
--   * The composite resolver key refuses an agent dismissing a finding about
--     its own edit — the reconciliation-shaped version of promoting its own
--     knowledge. `actors (id, kind)` already existed to refuse the other one.
--
-- `rationale` is the single free-text field on this path and the known hole in
-- the third invariant. 280 characters holds a sentence and not a function; the
-- API refuses control characters on top, so a pasted snippet has already lost
-- the newlines that made it code. `docs/13-threat-model.md` still has "is a cap
-- sufficient, or does free text have no place here at all" open against this
-- phase, and nothing here should be read as answering it.
CREATE TABLE "reconciliation_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"atom_id" uuid NOT NULL,
	"verdict" "finding_verdict" NOT NULL,
	"file_path" text NOT NULL,
	"line_start" integer,
	"line_end" integer,
	"rationale" text,
	"status" "finding_status" NOT NULL,
	"resolved_by" uuid,
	"resolved_by_kind" "actor_kind",
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_findings_violation_cites_lines" CHECK (verdict <> 'violated' or (line_start is not null and line_end is not null)),
	CONSTRAINT "reconciliation_findings_line_start_positive" CHECK (line_start is null or line_start >= 1),
	CONSTRAINT "reconciliation_findings_line_end_ordered" CHECK (line_end is null or line_end >= line_start),
	CONSTRAINT "reconciliation_findings_queue_biconditional" CHECK ((verdict = 'violated') = (status <> 'recorded')),
	CONSTRAINT "reconciliation_findings_resolver_is_human" CHECK (resolved_by_kind = 'human'),
	-- `resolved_by_kind` is in this list for a reason that is easy to miss and
	-- expensive to get wrong. A CHECK fails only on FALSE, so
	-- `resolved_by_kind = 'human'` *passes* when the column is NULL; and the
	-- composite foreign key below is MATCH SIMPLE, which Postgres skips entirely
	-- when any referencing column is NULL. Leave the kind nullable on a resolved
	-- row and both guards evaporate together, which would leave "only a human
	-- resolves a finding" enforced by application code alone — exactly the thing
	-- `docs/04-data-model.md` calls a convention with better marketing.
	CONSTRAINT "reconciliation_findings_resolution_complete" CHECK (status in ('recorded', 'open') or (resolved_by is not null and resolved_by_kind is not null and resolved_at is not null)),
	CONSTRAINT "reconciliation_findings_rationale_capped" CHECK (rationale is null or length(rationale) <= 280),
	-- The control-character clause is not decoration. This column is served back
	-- out — it is the pointer the human clicks — so without it an agent could
	-- put a newline and forty lines of source in a 1024-character field and have
	-- the server store and echo them. That would be a second free-text field,
	-- larger than the rationale and with none of its controls. A path does not
	-- contain a line break. The API refuses the Unicode line terminators and the
	-- invisible format characters too; this is the backstop for the ASCII ones.
	CONSTRAINT "reconciliation_findings_file_path_is_a_pointer" CHECK (file_path <> '' and length(file_path) <= 1024 and file_path !~ '^/' and file_path !~ '(^|/)\.\.(/|$)' and file_path !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- `org_id` and `project_id` on the same row must name the same tenant, and a
-- pair of single-column foreign keys does not say that.
--
-- Row-level security compares `org_id` against the GUC and nothing else, so a
-- row whose `org_id` is this tenant and whose `project_id` belongs to another
-- satisfies RLS *and* both single-column keys. It is invisible to the other
-- tenant — RLS filters it out on the way back — so the damage is not a read
-- leak; it is that the row exists at all, that this tenant can list it under
-- another tenant's project id, and that whether the insert succeeds answers a
-- question about the other tenant's data.
--
-- `recordReconciliation` cannot produce one, because it takes both ids from the
-- authenticated context. That is exactly the argument `docs/04-data-model.md`
-- rejects: a constraint that lives only in application code is a convention
-- with better marketing.
--
-- Note for whoever reads this next: this closes the gap for the two tables phase
-- 3 added. Migration 0010 closes it everywhere else, which is where the full
-- argument now lives.
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_org_key" UNIQUE ("id","org_id");--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_id_org_key" UNIQUE ("id","org_id");--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_project_in_org_fk" FOREIGN KEY ("project_id","org_id") REFERENCES "public"."projects"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_in_org_fk" FOREIGN KEY ("run_id","org_id") REFERENCES "public"."reconciliation_runs"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A finding must name an atom in its own project, and a plain reference to
-- `atoms(id)` does not say that.
--
-- Referential-integrity triggers run with `row_security = off`, so an atom id
-- belonging to another project — or another *org* — satisfies a single-column
-- foreign key without RLS ever seeing it. The damage is quiet rather than loud:
-- `countDrift` counts findings by `atom_id`, so a finding filed in project A
-- against project B's atom silently marks B's atom as checked, and B's queue
-- reports work nobody did.
--
-- The same trick `actors (id, kind)` uses for ratification. `atoms(id)` is
-- already unique as the primary key, but Postgres needs the pair declared
-- before it can be referenced, so the unique constraint below carries no index
-- cost worth naming and buys a constraint instead of a code path.
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_id_project_key" UNIQUE ("id","project_id");--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_atom_in_project_fk" FOREIGN KEY ("atom_id","project_id") REFERENCES "public"."atoms"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The composite key, reused. `actors` is unique on (id, kind), so a row naming
-- an agent's id must claim kind = 'agent' to satisfy this key — and then fails
-- `reconciliation_findings_resolver_is_human`. Two constraints, one refusal,
-- and neither of them is application code.
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_resolver_fk" FOREIGN KEY ("resolved_by","resolved_by_kind") REFERENCES "public"."actors"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "reconciliation_runs_project_created_idx" ON "reconciliation_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_findings_project_status_idx" ON "reconciliation_findings" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "reconciliation_findings_atom_created_idx" ON "reconciliation_findings" USING btree ("atom_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reconciliation_findings_project_path_idx" ON "reconciliation_findings" USING btree ("project_id","file_path");--> statement-breakpoint
CREATE INDEX "reconciliation_findings_run_idx" ON "reconciliation_findings" USING btree ("run_id");--> statement-breakpoint

CREATE POLICY "reconciliation_runs_org_isolation" ON "reconciliation_runs" AS PERMISSIVE FOR ALL TO "standfast_app" USING (org_id = nullif(current_setting('standfast.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('standfast.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "reconciliation_findings_org_isolation" ON "reconciliation_findings" AS PERMISSIVE FOR ALL TO "standfast_app" USING (org_id = nullif(current_setting('standfast.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('standfast.org_id', true), '')::uuid);--> statement-breakpoint

-- FORCE, so the policy binds the table owner too. Without it a migration or a
-- maintenance session running as the owner reads every org's findings, which is
-- exactly the query someone reaches for when debugging a false positive.
ALTER TABLE "reconciliation_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- No DELETE on either table, and no UPDATE on runs.
--
-- A dismissed finding is the numerator of our own kill metric, and the product
-- does not get to delete evidence against itself. The same argument that makes
-- `atom_events` append-only in migration 0000.
GRANT SELECT, INSERT ON "reconciliation_runs" TO "standfast_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "reconciliation_findings" TO "standfast_app";

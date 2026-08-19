-- Reverses 0003_extraction_provenance.sql.
--
-- Dropping these columns destroys the attribution they exist to record. That is
-- correct for a down migration — it returns the schema to a state that cannot
-- express the fact — and it is the reason the up migration is the cheap
-- direction and this one is not: rolling forward again gives you the columns
-- back, empty.
ALTER TABLE "section_extractions" DROP CONSTRAINT "section_extractions_candidates_coherent";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP CONSTRAINT "section_extractions_lease_iff_running";--> statement-breakpoint
DROP INDEX "section_extractions_project_id_idx";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP CONSTRAINT "section_extractions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP COLUMN "lease_expires_at";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP COLUMN "candidates_truncated";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP COLUMN "candidates_dropped";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP COLUMN "candidates_total";--> statement-breakpoint
ALTER TABLE "section_extractions" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "atoms" DROP COLUMN "extractor_version";

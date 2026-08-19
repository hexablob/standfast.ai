-- Reverse of 0002_extraction_invariants.sql, hand-written.
--
-- Reversible does not mean lossless. Rolling this back drops every extraction
-- run record, every suppression, and every embedding — there is nowhere else
-- for them to live. What it does restore exactly is the phase-0 shape of
-- `atoms` and `document_sections`, which is what the CI round trip checks.

DROP TRIGGER IF EXISTS "atoms_verify_quote_update" ON "public"."atoms";

DROP TRIGGER IF EXISTS "atoms_verify_quote_insert" ON "public"."atoms";

DROP FUNCTION IF EXISTS "standfast_verify_atom_quote"();

ALTER TABLE "public"."atoms"
	DROP CONSTRAINT IF EXISTS "atoms_source_span_not_empty";

ALTER TABLE "public"."atoms"
	DROP CONSTRAINT IF EXISTS "atoms_document_section_fk";

ALTER TABLE "public"."atoms" DROP COLUMN IF EXISTS "embedding";

-- The single-column key 0000 created, restored under its generated name. An
-- atom can once again name document A and a section of document B; that is the
-- defect this migration closed, and going back means going back to it.
ALTER TABLE "public"."atoms"
	ADD CONSTRAINT "atoms_section_id_document_sections_id_fk"
	FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "public"."document_sections"
	DROP CONSTRAINT IF EXISTS "document_sections_document_id_id_key";

-- Constraint back to index, same name. Dropping the constraint takes its
-- implicit index with it, so the index has to be recreated rather than left.
ALTER TABLE "public"."document_sections"
	DROP CONSTRAINT IF EXISTS "document_sections_document_ordinal_key";

CREATE UNIQUE INDEX IF NOT EXISTS "document_sections_document_ordinal_key"
	ON "public"."document_sections" USING btree ("document_id", "ordinal");

-- The policies and grants go with the tables.
DROP TABLE IF EXISTS "public"."atom_suppressions";

DROP TABLE IF EXISTS "public"."section_extractions";

DROP TYPE IF EXISTS "public"."extraction_status";

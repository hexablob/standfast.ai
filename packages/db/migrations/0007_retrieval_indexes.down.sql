-- Reverses 0007_retrieval_indexes.sql.
--
-- Dropped in the reverse order of creation, and the generated column last:
-- "atoms_search_vector_idx" indexes it, and dropping a column would take its
-- index with it silently. Naming both makes the round-trip test assert two
-- things rather than one.
--
-- Losing these loses no data. Every index here is derived — from `statement`,
-- `source_quote`, `embedding` and `status`, all of which survive — so an up /
-- down / up round trip rebuilds identical structures from the same rows. That
-- is the property migrations-reversible.integration.test.ts is checking, and it
-- is the reason this migration was written to add no table and no policy.
DROP INDEX IF EXISTS "atoms_superseded_by_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "atoms_structural_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "atoms_embedding_hnsw_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "atoms_trigram_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "atoms_search_vector_idx";--> statement-breakpoint
ALTER TABLE "atoms" DROP COLUMN IF EXISTS "search_vector";

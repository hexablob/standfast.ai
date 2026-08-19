-- Reverses 0008_query_egress_purpose.sql.
--
-- Postgres cannot remove a value from an enum, so the type is rebuilt without
-- it. The column is moved to `text` and back, which is why this is four
-- statements rather than one.
--
-- **It fails, deliberately, if any call was ever recorded under the purpose
-- being removed.** The cast back to the narrowed type raises on a row holding
-- `query-embedding`, and that is the correct behaviour rather than an
-- inconvenience: `docs/13-threat-model.md` (*Egress*, rule 3) makes the record
-- of what left the machine a disclosure a customer is entitled to, and a down
-- migration that quietly rewrote those rows — or dropped them — would be
-- falsifying it. An operator who genuinely needs to reverse this has to decide
-- what happens to that history first, in the open.
--
-- In practice the case does not arise, because the purpose cannot be
-- configured: it is absent from `PERMITTED_PURPOSES`, so no deployment can
-- make a call that would record it. That is precisely why the reversal is safe
-- to write this strictly.
ALTER TABLE "egress_events"
	ALTER COLUMN "purpose" TYPE text;--> statement-breakpoint
DROP TYPE "public"."egress_purpose";--> statement-breakpoint
CREATE TYPE "public"."egress_purpose" AS ENUM('extraction', 'embedding', 'judge', 'reranking');--> statement-breakpoint
ALTER TABLE "egress_events"
	ALTER COLUMN "purpose" TYPE "public"."egress_purpose"
	USING "purpose"::"public"."egress_purpose";

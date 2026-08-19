-- Reverses 0006_egress_disclosure.sql.
--
-- Dropping this table destroys the record of what left the machine, and there
-- is no other copy -- the whole point of the table is that the answer does not
-- live in a log file somebody has to be trusted to keep. A deployment that has
-- sent anything to a provider cannot roll this back and still answer rule 3's
-- question, which is the honest position for a down migration to take: it is
-- reversible, and reversing it costs the evidence.
DROP TABLE "egress_events";--> statement-breakpoint
DROP TYPE "public"."egress_purpose";

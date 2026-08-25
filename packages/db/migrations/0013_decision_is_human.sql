-- Only a human decides, and until now that was only half enforced.
--
-- `atoms` has carried the guarantee since migration 0000: `ratified_by` and
-- `ratified_by_kind` form a composite foreign key into `actors (id, kind)`, and
-- a check pins the kind to `'human'`. An agent's id cannot physically be stored
-- beside the literal `'human'`, so "an agent cannot promote its own knowledge"
-- is a constraint rather than a code path.
--
-- **`atom_events` had no such column, so it had no such guarantee.** A rejection
-- is not a ratification and writes no `*_by_kind`; the ledger keyed its actor by
-- `(actor_id, org_id)` alone. Nothing in the schema could refuse an agent
-- writing `rejected` or `retired` — the only guard was the route's 403 and a
-- predicate in the repository's `WHERE`, which is exactly what
-- `docs/04-data-model.md` calls a convention with better marketing. Phase 4 adds
-- two decisions a human makes, so the gap stopped being theoretical.
--
-- Three pieces, and each is doing different work:
--
--   1. `actor_kind`, filled by a trigger from `actors` rather than supplied by
--      the caller. A column a writer can set is a column a writer can get wrong,
--      and here getting it wrong is the whole attack. Nothing in the
--      application chooses this value.
--   2. The composite foreign key, which is belt and braces: it holds even if the
--      trigger is ever dropped, because `actors` is unique on `(id, kind)`.
--   3. The check, which is where the rule actually lives. `proposed` is the one
--      event an agent may write — that is the entire point of `propose`, and of
--      the extractor. Every other event is a decision, and decisions are human.
--
-- `superseded` is covered by the same check, which matters: it is written on the
-- incumbent during a ratify-with-supersede, and nothing else guarded that row.
ALTER TABLE "atom_events" ADD COLUMN "actor_kind" "actor_kind";--> statement-breakpoint

-- Backfill from the actor each existing row already names. There is no ambiguity
-- to resolve: `actor_id` is a foreign key, so every row has exactly one answer.
UPDATE "atom_events" e
   SET "actor_kind" = a."kind"
  FROM "actors" a
 WHERE a."id" = e."actor_id" AND a."org_id" = e."org_id";--> statement-breakpoint

ALTER TABLE "atom_events" ALTER COLUMN "actor_kind" SET NOT NULL;--> statement-breakpoint

-- Authoritative, not advisory. The trigger overwrites whatever the caller sent,
-- so a client cannot claim to be a human by saying so — which is the difference
-- between recording the kind and enforcing it.
CREATE OR REPLACE FUNCTION "atom_events_set_actor_kind"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT a.kind INTO NEW.actor_kind
    FROM actors a
   WHERE a.id = NEW.actor_id AND a.org_id = NEW.org_id;

  IF NEW.actor_kind IS NULL THEN
    RAISE EXCEPTION 'no actor % in org %', NEW.actor_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "atom_events_actor_kind_insert"
BEFORE INSERT ON "atom_events"
FOR EACH ROW EXECUTE FUNCTION "atom_events_set_actor_kind"();--> statement-breakpoint

ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_actor_kind_fk" FOREIGN KEY ("actor_id","actor_kind") REFERENCES "public"."actors"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- `proposed` is the one event an agent may write. Everything else is a decision.
ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_decision_is_human" CHECK ("event" = 'proposed' OR "actor_kind" = 'human');

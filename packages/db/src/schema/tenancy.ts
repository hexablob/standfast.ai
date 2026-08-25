import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorKind } from "./enums.js";
import { orgIsolationPolicy, orgRootPolicy } from "./rls.js";

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("orgs_slug_key").on(t.slug), orgRootPolicy()],
).enableRLS();

export const actors = pgTable(
  "actors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: actorKind("kind").notNull(),
    displayName: text("display_name").notNull(),

    // How the system finds an actor it created for itself, rather than one a
    // person made. `display_name` is the only other handle and it is editable,
    // so a worker that resolved its own identity by name would stop working
    // the moment somebody renamed a row in a list.
    //
    // Null for every actor a user creates, and NULLs do not collide in a
    // Postgres unique constraint — which is exactly the wanted behaviour here.
    // Unique per org rather than per row, because 'extractor' means a different
    // actor in each tenant. Deliberately not a partial unique on
    // `kind = 'agent'`: phase 3 gives an org more than one agent, and a
    // constraint that has to be dropped to make progress was the wrong
    // constraint.
    systemKey: text("system_key"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Not redundant with the primary key. This is the target of the composite
    // foreign key on `atoms.(ratified_by, ratified_by_kind)`, which is what
    // stops an agent ratifying anything. See docs/04-data-model.md.
    //
    // A table constraint, not a unique index: Postgres requires a unique
    // *constraint* to reference, and drizzle emits indexes after the foreign
    // keys that would need them.
    unique("actors_id_kind_key").on(t.id, t.kind),
    // The tenancy sibling of the key above. `(id, kind)` answers "is this actor
    // a human"; `(id, org_id)` answers "is this actor ours". Both questions get
    // asked of the same column by different constraints, so both pairs are
    // declared. Migration 0010 has the full argument.
    unique("actors_id_org_key").on(t.id, t.orgId),
    unique("actors_org_system_key_key").on(t.orgId, t.systemKey),
    index("actors_org_id_idx").on(t.orgId),
    orgIsolationPolicy("actors"),
  ],
).enableRLS();

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull(),
    // The key itself is never stored. `prefix` is the displayable head so a
    // user can tell two keys apart in a list; `hash` is what is compared.
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_org_prefix_key").on(t.orgId, t.prefix),
    index("api_keys_actor_id_idx").on(t.actorId),
    // The actor this key authenticates must belong to the same org the key
    // does. RLS checks `org_id` alone and would not have noticed.
    foreignKey({
      columns: [t.actorId, t.orgId],
      foreignColumns: [actors.id, actors.orgId],
      name: "api_keys_actor_in_org_fk",
    }).onDelete("cascade"),
    orgIsolationPolicy("api_keys"),
  ],
).enableRLS();

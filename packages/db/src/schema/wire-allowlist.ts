/**
 * The exact column set of every tenant table, reviewed one column at a time.
 *
 * Most of these tables serialise; a few (`section_extractions`,
 * `atom_suppressions`) never leave the database, and one column — `embedding` —
 * is listed on a table that does serialise but is itself withheld by
 * `AtomSchema`. Listing is the review record, not the permission.
 *
 * Invariant 3 — source code never leaves the machine — is enforced here by
 * allowlist rather than by denylist (docs/02-principles.md, 9). A denylist
 * would have to anticipate the name of the column nobody thought to forbid.
 *
 * `schema-guards.integration.test.ts` reads information_schema.columns and
 * asserts equality with this map. Adding a column to one of these tables
 * fails the test until someone adds it here too — in a diff a reviewer sees,
 * with a commit message that has to justify it.
 *
 * Reconciliation findings (phase 3) join this map when they exist. They will
 * carry file_path, line_start, line_end, verdict and atom_id: a verdict and a
 * pointer, per docs/01-thesis.md. No column that can hold a snippet.
 */
export const WIRE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  orgs: ["id", "name", "slug", "created_at"],
  actors: [
    "id",
    "org_id",
    "kind",
    "display_name",
    // Listed, and internal. It names an actor the system created for itself —
    // 'extractor' today — so that nothing has to resolve one by display name.
    // Null for every actor a user creates.
    "system_key",
    "created_at",
  ],
  api_keys: [
    "id",
    "org_id",
    "actor_id",
    "prefix",
    "hash",
    "scopes",
    "expires_at",
    "revoked_at",
    "last_used_at",
    "created_at",
  ],
  projects: ["id", "org_id", "name", "slug", "created_at"],
  documents: [
    "id",
    "org_id",
    "project_id",
    "path",
    "title",
    "body",
    "content_hash",
    "created_at",
    "updated_at",
  ],
  document_sections: [
    "id",
    "org_id",
    "document_id",
    "ordinal",
    "heading_path",
    "body",
    "section_hash",
  ],
  atoms: [
    "id",
    "org_id",
    "project_id",
    "document_id",
    "section_id",
    "statement",
    "kind",
    "status",
    "source_quote",
    "source_span",
    "ratified_by",
    "ratified_by_kind",
    "ratified_at",
    "superseded_by",
    // Listed, and deliberately absent from `AtomSchema`. Being in this map
    // means the guard knows the column exists; it is not permission to
    // serialise it. The two are separate on purpose — a column nobody listed
    // here is a column nobody reviewed, whether or not it ever ships.
    "embedding",
    // Also listed and also absent from `AtomSchema`. It answers "which
    // extractor produced this, if any" — bookkeeping for re-projection, not
    // something an agent asked for. Null means no extractor did.
    "extractor_version",
    // Listed, internal, and derived. A generated tsvector over `statement` and
    // `source_quote` (migration 0007), holding nothing those two columns do not
    // already hold — which is the whole review: it cannot leak what its inputs
    // could not. Absent from `AtomSchema`, and serialising it would send an
    // agent a lexeme table it has no use for.
    "search_vector",
    "created_at",
  ],
  atom_events: ["id", "org_id", "atom_id", "event", "actor_id", "at"],
  section_extractions: [
    "id",
    "org_id",
    "section_id",
    "project_id",
    "extractor_version",
    "section_hash",
    "status",
    "error",
    "candidates_total",
    "candidates_dropped",
    "candidates_truncated",
    "attempts",
    "started_at",
    "lease_expires_at",
    "finished_at",
  ],
  // Never serialised to an agent, and listed for the opposite reason to the
  // others: this is the table a *customer* reads, and the review it records is
  // that no column here can hold prose. `input_chars` and `input_items` are
  // measurements of what left; nothing stores what left.
  egress_events: [
    "id",
    "org_id",
    "project_id",
    "section_id",
    "purpose",
    "destination",
    "model",
    "input_items",
    "input_chars",
    "at",
  ],
  atom_suppressions: [
    "id",
    "org_id",
    "project_id",
    "section_id",
    "statement",
    "reason",
    "similarity",
    "duplicate_of_atom_id",
    "created_at",
  ],
} as const;

/** Every table the migration is expected to create, RLS-forced and policied. */
export const TENANT_TABLES = Object.keys(WIRE_ALLOWLIST);

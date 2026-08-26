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
  // `reason` and `reason_note` are the rejection vocabulary phase 4 added. They
  // are the labelled corpus `docs/12-evaluation.md` gets out of ordinary use:
  // `duplicate` on an atom deduplication failed to suppress is a threshold miss
  // with a timestamp on it. `reason_note` is the only free-text field a human
  // writes anywhere in this system — capped at 280, and written once, because
  // `atom_events` is append-only.
  atom_events: [
    "id",
    "org_id",
    "atom_id",
    "event",
    "actor_id",
    // Filled by a trigger from `actors`, never by a caller. It is what makes
    // "only a human decides" a constraint on this table rather than a predicate
    // in a repository — see migration 0013.
    "actor_kind",
    "reason",
    "reason_note",
    "at",
  ],
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
  // One submission of verdicts. `verdict_count` is the denominator of the kill
  // metric and is computed server-side from the rows actually written — a
  // client-supplied count would let a caller improve our own false-positive
  // rate by inflating it.
  reconciliation_runs: [
    "id",
    "org_id",
    "project_id",
    "actor_id",
    "trigger",
    "verdict_count",
    "created_at",
  ],
  // A verdict and a pointer.
  //
  // **Read this list before adding to it.** The third founding invariant is
  // that source code never leaves the customer's machine, and this is the one
  // path where an agent that has just *read* source is asked to say something
  // about it. `file_path`, `line_start` and `line_end` point into a tree this
  // server has never seen and never will. There is deliberately no column for a
  // snippet, a diff, an excerpt, a hash of content, or anything else derived
  // from the bytes of a file — their absence is the control.
  //
  // `rationale` is the exception and the known hole: the only free-text field
  // anywhere on the reconciliation path. It is capped at 280 characters and
  // rejected by the API if it carries a control character, so what fits is one
  // sentence and not a function. It is never returned to another agent, never
  // indexed, never embedded, and served by no MCP tool — appearing in this list
  // is the record that a reviewer saw the column, not permission to serialise
  // it. `docs/13-threat-model.md` still has "is a length cap sufficient, or does
  // free text have no place here at all" open against phase 3; removing this
  // column is one line here, one Zod field and one column.
  reconciliation_findings: [
    "id",
    "org_id",
    "project_id",
    "run_id",
    "atom_id",
    "verdict",
    "file_path",
    "line_start",
    "line_end",
    "rationale",
    "status",
    "resolved_by",
    "resolved_by_kind",
    "resolved_at",
    "created_at",
  ],
} as const;

/** Every table the migration is expected to create, RLS-forced and policied. */
export const TENANT_TABLES = Object.keys(WIRE_ALLOWLIST);

/**
 * Tables that exist in `public` and are deliberately not tenant tables.
 *
 * The map above is exhaustive over the schema: `schema-guards` reads `public`
 * and requires every base table in it to appear in exactly one of these two
 * maps, so a migration that adds a table nobody classified fails before it
 * merges. Without that, the allowlist is only strong against a column added to
 * a table someone already thought about — it iterates its own keys, and a table
 * it does not know exists is a table it cannot check.
 *
 * That check needs somewhere to put the table with no `org_id` at all: a global
 * lookup, a partition parent, bookkeeping that belongs to the database rather
 * than to a customer. Such a table cannot simply join the allowlist, because
 * `TENANT_TABLES` is derived from its keys and every key is asserted to have
 * FORCE ROW LEVEL SECURITY and an isolation policy.
 *
 * This is not the register for "never serialised". Several tables above —
 * `api_keys`, `atom_suppressions`, `section_extractions`, `egress_events` —
 * never cross the wire and are listed there anyway, because listing is the
 * review record and every tenant column earns one. This map is only for tables
 * outside the tenant model entirely.
 *
 * The value is the reason, addressed to whoever reads the diff. An entry with
 * no argument behind it is an entry that should have been an allowlist entry.
 */
export const NON_TENANT_TABLES: Readonly<Record<string, string>> = {
  // Empty, and worth keeping empty: every table the migrations have created so
  // far belongs to an org.
};

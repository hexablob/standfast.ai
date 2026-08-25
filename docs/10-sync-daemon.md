<!-- docs/10-sync-daemon.md -->
# Sync daemon

> **Status: the one-shot is built.** `standfast sync` is the intended write
> path: a CLI one-shot a human invokes, implemented in `packages/cli` —
> `sync-plan.ts` is the pure planner, `sync.ts` the filesystem and network
> around it. No watcher process exists; *daemon* below names the design, and
> the one-shot is its first and only trigger. `standfast doc push` remains the
> single-file escape hatch, and whether it survives is still under *Open*.
> The blocking dependency named under *What happens to atoms* is discharged:
> `putDocument` matches sections by `section_hash`, then matches the remainder
> by `(ordinal, heading_path)`, so an edited section keeps its row, its id and
> its atoms, and only a section that was edited *and* moved falls back to
> delete-and-insert.

## What this document fixes

The daemon looks like plumbing and is not. Three properties make it the
component with the most expensive mistakes on the customer's side of the
trust boundary.

1. **It is the *intended* client-side write path into documents, and the only
   one an agent can reach.** `docs/08-mcp-server.md` has no `put_document`
   tool, and says why: two write paths into the same source are two ways for it
   to disagree with itself, and the folder stays the working surface
   (`docs/01-thesis.md`). That absence is only coherent if this document
   exists.

   It is not the only *possible* write path, and the design below depends on
   admitting that. `PUT /v1/projects/{projectId}/documents` is open to any
   credential in the org: `standfast doc push` from a second machine, a CI script,
   or a colleague's laptop all reach it, and `docs/11-git-export.md`'s
   round-trip procedure calls it by name. See *Who wins*.
2. **It is the only component that decides which files leave the machine.**
   Invariant 3 protects source code, and it protects it structurally: there is
   no column anywhere in the schema that can hold source
   (`docs/04-data-model.md`). Markdown is different. Markdown *is* the
   product's input, so it leaves, and nothing downstream can tell a design
   note from a private one. The scope configuration is the only control.
3. **It writes to the thing atoms project from.** Documents cascade to
   sections, sections cascade to atoms. Every other client of the API can be
   wrong and produce a bad row. This one can be wrong and destroy ratified
   knowledge.

## The shape: one direction, and it never writes to the folder

**Settled: the daemon syncs folder → server, and never server → folder.**

Three reasons, in increasing order of how much they cost to get wrong.

The folder is the working surface (`docs/01-thesis.md`, *what Standfast is not*).
A background process that edits files while a developer edits them is an
editor, and this product is explicitly not one.

The reverse direction already has an owner. `standfast export` writes Markdown to
a directory the customer controls today, and `docs/11-git-export.md` owns
where that goes next. Two components writing the same file is a loop, and a
loop between a watcher and an exporter is the kind that runs at full speed.

And the failure modes are not symmetric. The worst bug in a one-way sync is a
bad upload, and a bad upload is recoverable — `DELETE /v1/documents/{id}`
removes the row, its sections and every atom quoting them. The worst bug in a
two-way sync overwrites the developer's working copy, which Standfast cannot
restore, because Standfast is not a backup of it.

### It is a function before it is a process

```
plan(scope, localState, remoteState) → operations
```

Pure: no filesystem, no network, no clock. `localState` is a list of
`(path, size, mtime, hash)`; `remoteState` is a list of
`(path, content_hash)`; `operations` is a list of uploads, conflicts,
absences and no-ops. Watching, polling, a git hook and a CI step are four ways
to call it, which is precisely why the trigger can stay open (below) without
blocking anything.

One consequence worth recording because it surprises people: **this planner
cannot live in `packages/core`.** `core` is AGPL-3.0-only and the daemon runs
on the customer's machine, so the daemon is Apache-2.0, and no Apache package
may import an AGPL one (`docs/03-architecture.md`). A licence boundary drawn
to keep the SDK integrable decides where a pure function with no dependencies
is allowed to sit. That is the boundary working as designed, not a wart, but
it is not obvious from the code.

## Scope: an allowlist, and it gates the read

Configuration is a file in the customer's repository, committed, naming one
project:

```jsonc
// standfast.sync.json
{
  "project": "9f3c…",
  "include": [
    "CLAUDE.md",
    "docs/**/*.md",
    "adr/*.md"
  ]
}
```

The name is settled: `standfast.sync.json`, its own file rather than a key
inside `standfast.json` — that name is already the export manifest's, and
`standfast export` treats a directory holding one as its own to sweep, so one
file serving two features would let a sync scope be mistaken for an ownership
sentinel. One folder, one project; a monorepo syncing into several projects is
several folders.

**There is no `exclude` key.** `docs/02-principles.md` (9) — allowlist, never
denylist, for anything that leaves the machine — and this is the document
where that principle costs something, so it has to be argued rather than
cited.

A denylist fails by omission, and the failure is silent, immediate and
permanent: you learn that `notes/2026-compensation.md` matched after its
contents are on the server. An include-only list also fails by omission, and
its failure is that a document does not sync — visible in the first
`standfast sync status`, fixed by adding a glob, and harmless in the meantime.
The same class of human error, two failure modes that are nowhere near the
same size.

The cost is real and should be stated rather than glossed: you will sometimes
write three globs where one exclusion would have done. Accepted.

Two rules turn the list from nominal into protective.

**The allowlist gates the read, not the send.** A path that matches no glob is
never opened. This puts the check upstream of everything that could later go
wrong — a bug in hashing, batching, retry or serialisation cannot upload
content the process never read. A check at the send boundary is one refactor
away from being bypassed by a code path that already holds the bytes.

**The first run of a scope is a plan.** A new or edited `include` list prints
every matched path and uploads nothing. Confirmation is recorded against a
digest of the resolved list, so widening a glob re-arms the plan rather than
inheriting yesterday's consent.

Beyond that: symlinks are not followed, and a path that resolves outside the
config file's directory is refused. This is the third place the same rule
applies — `storagePath` in `packages/cli/src/commands.ts` refuses a file
outside the working directory, and `standfast export` refuses a server-supplied
path that escapes the export directory — so it is a house rule, not a special
case.

Stored paths stay repository-relative with forward slashes, exactly as
`storagePath` computes them today. An absolute path would ship the operator's
home directory and username to the server, tie the document to one machine,
and leave export unable to reconstruct anything.

### What the daemon does not send

It enumerates the folder to resolve globs. That enumeration stays local. What
crosses the wire is matched paths and their bodies — no directory listing, no
count of what did not match, no tree.

Standfast holds no representation of source code (`docs/01-thesis.md`), and a
file tree is a representation of source code. This is easy to violate by
accident, and it would arrive looking like a courtesy: a progress line reading
*"syncing 12 of 4 812 files"* has already told the server how large the
repository is, and one refinement later it is sending the paths it skipped so
the user can debug their globs. Debugging globs is a local operation and stays
local.

## Deciding that a document changed

`packages/core` already computes two hashes. They answer different questions,
and the daemon must not merge them into a third scheme.

| Hash | Input | Question it answers | Computed by |
| --- | --- | --- | --- |
| `contentHash` | document body | should this document be uploaded? | the daemon, and the server on write |
| `sectionHash` | heading path + section body | which sections need re-extracting? | the server only |

The division of labour: **the daemon sends bodies; the server sections them.**
`putDocument` re-derives sections with `sectionMarkdown` and never accepts
them from a caller, because a client that supplied sections could assert a
provenance the content does not support. `sectionHash` is deliberately
content-based rather than position-based, so that a section which moves within
a document keeps its identity — that property belongs to extraction, and the
daemon has no use for it.

Detection is two stages, and only one of them is authoritative.

| Stage | Signal | Authority |
| --- | --- | --- |
| Filter | `stat`: size, mtime, inode | never |
| Decide | `contentHash` of the file bytes | always |

mtime lies in both directions, and both lies are expensive. `git checkout`
rewrites mtime on files whose content did not change; `touch`, a restored
backup, an rsync and a container with a skewed clock all move it independently
of content — that direction produces uploads of unchanged documents, which is
noise now and wasted model spend once extraction exists. The other direction
is worse: a coarse filesystem timestamp, a rewrite within the same second, or
a copy that preserves mtime can leave a changed file looking untouched, and a
silently skipped change is drift, which is the failure this product exists to
fix. So `stat` is allowed to say "unchanged and untouched, skip the read", and
nothing else.

Editors save by writing a temporary file and renaming it, so one save produces
several filesystem events. Events coalesce per path and the hash is taken
after a quiet period. A default in the low hundreds of milliseconds is a
starting point; nobody has measured it, and it is listed under *Open*.

Bytes are uploaded verbatim, decoded as UTF-8, with no normalisation of line
endings and no trailing-newline fixups. Two reasons: normalising would make
the daemon's hash disagree with the server's over the same file, and
`sectionMarkdown` already strips a trailing `\r` per line when it sections, so
a CRLF document sections correctly without anyone rewriting it.

### The licence problem in three lines of code

`contentHash` lives in `packages/core`, which is AGPL. The daemon is Apache
and may not import it. Three ways out:

- **Upload everything and let the server hash.** Defeats the purpose, and
  worse, uploads content in order to decide whether it should have been
  uploaded. Exactly backwards for a privacy surface.
- **Move the hash into the Apache half.** Sectioning would have to follow it
  or the two would separate, and sectioning is server-side by design.
- **Re-derive it in the client and pin it with a test.** Chosen.

The hash is `createHash("sha256").update(text, "utf8")` and nothing else, so
re-deriving it is three lines. The drift risk is not today's definition — it
is a future one that normalises something. The guard is a test in the AGPL
half, which may depend on the client packages (`packages/api` already declares
`sdk`, `cli` and `mcp` as devDependencies for cross-boundary tests), asserting
that both implementations agree over a committed vector file containing CRLF,
a missing trailing newline, and non-BMP characters. If `contentHash` ever
gains normalisation, the definition moves; it is not copied a second time.

## Conflict: the folder changed and the server changed

The daemon keeps a journal: per document, the `content_hash` it last uploaded
successfully. That is the **base**. It is a hash, not a copy of the body — the
folder holds the body, and a second copy would make the daemon a second store
of the customer's documents.

The remote half of the comparison comes from
`GET /v1/projects/{projectId}/documents/manifest`: `(id, path, contentHash)`
per document, paged, bodies never selected — fetching every body to learn its
hash would be the expensive way to ask a yes/no question.

| local vs base | server vs base | Action |
| --- | --- | --- |
| unchanged | unchanged | nothing |
| changed | unchanged | upload, re-base |
| unchanged | changed | report; write nothing |
| changed | changed | **conflict**: write nothing, report, wait for a human |
| absent | any | report; see *Deletion* |

The server can diverge because `PUT /v1/projects/{projectId}/documents` is
open to any credential in the org. `standfast doc push` from a second machine, a
script, or a colleague's laptop all reach it. The daemon is the *intended*
write path, not the only possible one, and a design that assumed otherwise
would corrupt data the first time someone used the CLI it ships alongside.

**Who wins: the folder, but never silently.** In the conflict row the daemon
does not overwrite, because overwriting is destructive twice — it discards
what the other writer wrote, and, because atoms cascade from sections, it
discards atoms projected from it. Resolution is a human act:
`standfast sync resolve <path> --take-local` uploads and re-bases;
`--take-remote` re-bases without uploading, leaving the folder untouched and
accepting that the next local edit conflicts again.

There is no merge. Merging Markdown is a text-merge problem git already solves
better, and doing it inside a background process means doing it with no human
present — which is the one condition under which a wrong merge goes unnoticed.

How the user finds out, in the order they are likely to see it: the run's own
output; `standfast sync status`, which is the same information on demand; and a
non-zero exit code, which is what makes a hook or a CI trigger fail loudly
instead of skipping quietly.

Deliberately **not** the MCP `status` tool. That reports the state of the
knowledge base to an agent. A sync conflict is a fact about one developer's
working copy, it is not actionable by an agent, and putting it there would
spend session tokens in every session to say so.

## Deletion: absence is reported, never applied

**A file that disappears from the folder never deletes anything.**

The asymmetry decides it, and it is the same asymmetry `docs/14-roadmap.md`
applies to the kill metric: break towards the recoverable error.

Leaving a document on the server that no longer exists locally costs stale
knowledge — which is the condition reconciliation exists to surface, so the
system already has a way to notice it. Deleting it destroys, in one statement
and with no tombstone, every atom projected from that document, canonical ones
included, and their `atom_events` with them.

And "the file is gone" is usually not "the author deleted it". It is a branch
switch, a shallow or partial clone, a rename the watcher saw as a delete, a
network mount that dropped, or a scan that ran while a build was rewriting a
directory. Every one of those resolves itself in seconds; a cascade does not.

So absence marks the document *unseen locally* in the journal and reports it.
Removing it from the server is `standfast doc rm <id>` — deliberate, one
document, named by its id. The bulk `sync prune` this section once promised is
not built: a command that turns a list of absences into a list of deletions is
exactly the shape of the branch-switch incident above, and nobody has missed
it yet. If it is ever built, the guard it would need applies: a scan that
finds more than a small fraction of tracked documents missing reports and
stops rather than offering to prune them all — and that fraction is a number
nobody has measured, so it stays under *Open* with the prune itself.

## What happens to atoms

Two cases. One is a design decision; the other is a blocking dependency on
phase 1 that the current implementation would violate on the first save.

### A section's hash moves

The section's content changed, so it needs re-extraction. What happens to
atoms already projected from it — implemented in `reconcileSections`, inside
the same transaction as the write:

- The atom's `source_quote` is checked against the new section body. If the
  quote still appears verbatim, its `source_span` is re-anchored to the first
  occurrence and the atom stands — this is what
  `packages/core/src/markdown.ts` counts offsets in Unicode code points for.
- If the quote is gone, the atom's source is gone with it. It is neither
  silently deleted nor silently kept: the atom stays exactly as it was, and
  its id is reported in `staleCitations` on the `putDocument` result, which
  the HTTP route deliberately drops from the wire. Deciding that a decision
  no longer holds is a ratification-shaped act, and an agent cannot perform
  one (`docs/01-thesis.md`, invariant 2).
- **The schema still cannot express that state, on purpose.** No
  `atom_status` value and no `atom_event` means *"the prose this was
  extracted from changed underneath it"*, and that vocabulary is phase 1's
  to add. Until it rules, the stale citation is representable on the
  internal result and nowhere else — recorded, never acted on.

### The blocking dependency

`putDocument` used to delete every row in `document_sections` for the document
and re-insert them, so section ids were new on every write and
`atoms.section_id`, being `on delete cascade` (`docs/04-data-model.md`), took
every atom with them. **Every re-upload deleted every atom projected from the
document.** `reconcileSections` in
`packages/db/src/repositories/documents.ts` no longer does that: it matches the
incoming sections against the stored ones by `section_hash`, keeps and
renumbers what matches, and deletes only what does not.

What used to fail was the edited section. Its text changed, so its hash
changed, so no stored row matched it, so the row was deleted and the atoms
cascaded — intolerable under a daemon that uploads on every save: a
whitespace fix in one paragraph discarded a week of ratification across that
paragraph, and the throughput of that ratification is a first-class product
metric (`docs/02-principles.md`, 5). Step 2 below closes exactly this.

The rule, in full, as `reconcileSections` implements it. Sections are matched
and updated, not rebuilt:

1. Match by `section_hash` first. An unchanged section keeps its row and its
   id whatever its new ordinal — which is the whole reason the hash is
   content-based rather than position-based.
2. Then match the remainder by `(ordinal, heading_path)`, exact on both
   parts. The key is unique on each side because `(document_id, ordinal)` is
   unique, so this is a lookup, not a heuristic: an edited section keeps its
   identity, is re-enqueued for extraction, and its atoms are re-anchored
   rather than destroyed. A section that was edited *and* moved in the same
   push misses the key and falls back to delete-and-insert by design — a
   looser rule could marry the wrong rows, and a wrong identity is worse
   than a lost one.
3. Unmatched incoming sections are inserts. Unmatched existing sections are
   deletes, and those are the only deletes that cascade to atoms.

All three steps have landed, and they landed together with the two halves
that make step 2 safe: the re-anchoring above, and the claim-side hash
comparison — a `section_extractions` row that succeeded at another hash no
longer answers "already succeeded", so a re-enqueued edit is work, not a
skip. The daemon no longer waits on this section. `standfast doc push` and
the daemon are the same write, and on an edit it is no longer destructive.

### A document is deleted

The cascade is total, and that is exactly what makes it the privacy remedy:
`DELETE /v1/documents/{id}` removes the body, its sections and every atom
quoting them in one statement, leaving nothing holding the text. The property
that makes an accidental delete unrecoverable is the property that makes a
deliberate purge complete.

Which is the argument for the rule above, stated the other way round: the
daemon may propose deletions, and must never perform one unasked.

## The incident this is designed around

Someone points a daemon at a repository root with `**/*.md`, and the tree
contains `notes/2026-compensation.md`. After the upload there is no technical
control left: the body is stored, sectioned, extracted, embedded, and eligible
to be quoted into another agent's context pack.

The controls, in the order they fire:

| # | Control | Fires |
| --- | --- | --- |
| 1 | include-only globs, no `exclude` | before any read |
| 2 | plan-then-confirm on a new or widened list | before any read |
| 3 | the allowlist gates the read | before any read |
| 4 | symlinks not followed, escaping paths refused | before any read |
| 5 | first upload of a path reported distinctly from an update | at the send |
| 6 | `standfast doc rm`, and the cascade | after |

The ordering is the point. Five of the six fire before any content leaves, and
the sixth is cleanup. A design that leans on cleanup for privacy is a design
that has already failed — deleting the row does not un-see the content and
does not reach a backup.

`docs/02-principles.md` (2) asks for a guarantee a user can attempt to break
and watch fail. The checkable form here: a test points the planner at a
fixture tree containing an unmatched private file, through a filesystem stub
that throws on any read outside the resolved allowlist, and asserts the run
completes. A stub that throws is the difference between "we filter it out" and
"we never touched it".

## Trigger and packaging

**Settled: a CLI one-shot, human-invoked.** `standfast sync` is a mode of
`packages/cli`, not a package and not a process — nothing to install,
supervise or debug, and it runs only while someone is watching, which is the
condition the privacy controls are strongest under. The one-shot is the
primitive the other trigger shapes would call: a git hook or a CI step is one
line invoking it, and a long-running watcher, if measurement ever argues for
one, wraps the same `plan()`. The trigger-dependent answers settle with it:
an unreachable server fails the run loudly — exit 1, nothing uploaded, the
journal untouched — and the debounce window is moot for a run with no
watcher, deferred to the watcher that would need it.

What holds regardless: it is Apache-2.0, it reaches the server through
`@standfast/sdk` over HTTPS and never touches Postgres, it authenticates with
an API key like any other client, and it holds the journal and the
confirmed-scope digest locally beside the CLI's own configuration
(`XDG_CONFIG_HOME`, as `packages/cli/src/config.ts` resolves it today) —
outside the repository, because two developers must not share a base, and
outside the credential file, because logout must not destroy it.

## Considered and declined

Recorded so each question is asked once.

- **Two-way sync.** Covered above. It makes Standfast an editor, duplicates
  `docs/11-git-export.md`, and turns a recoverable bug into an unrecoverable
  one.
- **A local copy of the last-uploaded body, for a real three-way merge.** It
  doubles the customer's documents on disk, makes the daemon a second store of
  them, and automates precisely the decision a human should be shown.
- **An `exclude` key "just for convenience".** It is a denylist on the path
  where content leaves the machine. If it exists it will be the thing people
  reach for, and the include list becomes `**/*.md` the same afternoon.
- **`.gitignore` as the scope.** Superficially perfect — it is already a list
  of things not to share — and wrong twice. It is a denylist, and it answers a
  different question: a file being tracked by git is a decision to version it
  with the team, not consent to send it off the machine.
- **Scope configured server-side.** It would mean the server telling a process
  on the customer's machine which files to open. Scope is a local decision, in
  a local file, in the repository, reviewable in a diff — even though that
  means two machines can disagree about it.
- **The daemon computing section hashes, or extracting, locally.** The server
  re-derives sections from the body anyway, because it cannot trust a
  client-supplied provenance. A second implementation would exist only to
  disagree with the first.
- **Uploading on mtime alone**, without hashing. Both failure directions are
  bad, and one of them is silent drift.
- **Deleting server documents when a file disappears.** The cascade reaches
  ratified atoms and there is no undo.
- **A document-writing MCP tool as the sync path.** Already declined in
  `docs/08-mcp-server.md`. Repeated here because this is the document whose
  existence justifies that absence.
- **Sending a file listing, or a skipped-path list for diagnostics.** A file
  tree is a representation of source code.

## Open

- **The bulk-absence fraction**, if `sync prune` is ever built — see
  *Deletion*. A number nobody has measured, and inventing it here is the
  failure `docs/02-principles.md` (10) describes.
- **Whether `standfast doc push` survives the daemon.** `docs/14-roadmap.md` says
  the daemon demotes it to a convenience; `docs/08-mcp-server.md` says two
  write paths into one source are two ways for it to disagree. Keeping it as
  an escape hatch and removing it are both defensible, and the conflict
  handling above works either way.
- **API-key scopes.** `api_keys.scopes` exists in the schema and nothing reads
  it — `requireApiKey` puts it on the context and no route checks it. The
  daemon is the first client with an obvious reason for a narrow one: write
  documents, and nothing else. Whether scope enforcement lands with the daemon
  or earlier is undecided.
- **A size cap on an individual document.** A Markdown file can contain a
  base64 blob. Nothing today refuses one, and the body column is `text`.

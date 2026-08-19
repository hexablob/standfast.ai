<!-- docs/10-sync-daemon.md -->
# Sync daemon

> **Status: designed, not implemented.** No sync daemon exists. Today the
> whole write path for documents is `standfast doc push <file.md>`, which uploads
> a file a developer named, unconditionally. Everything below is decided;
> none of it is built. `docs/14-roadmap.md` places it in phase 4, and one
> dependency on phase 1 is named under *What happens to atoms* — it is a
> blocking dependency, not a preference.

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
`standfast sync resolve --take-local <path>` uploads and re-bases;
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
Removing it from the server is `standfast sync prune`, which lists what it would
delete and asks.

A guard applies even to that explicit path: if a scan finds more than a small
fraction of tracked documents missing at once, the daemon reports and stops
rather than offering to prune all of them. That shape is a branch switch or a
failed mount, not a sequence of edits. The fraction is a number nobody has
measured, and it goes to *Open* rather than being invented here.

## What happens to atoms

Two cases. One is a design decision; the other is a blocking dependency on
phase 1 that the current implementation would violate on the first save.

### A section's hash moves

The section's content changed, so it needs re-extraction. What happens to
atoms already projected from it:

- The atom's `source_quote` is checked against the new section body. If the
  quote still appears verbatim, its `source_span` is updated and the atom
  stands — this is what `packages/core/src/markdown.ts` counts offsets in
  Unicode code points for.
- If the quote is gone, the atom's source is gone with it. It is neither
  silently deleted nor silently kept. It is surfaced for a human, because
  deciding that a decision no longer holds is a ratification-shaped act, and
  an agent cannot perform one (`docs/01-thesis.md`, invariant 2).
- **The schema cannot express that state today.** `atom_status` is
  `provisional | canonical | rejected | superseded`; `atom_event` is
  `proposed | ratified | rejected | superseded`. None of them means *"the
  prose this was extracted from changed underneath it"*. Phase 1 owns the
  addition. It is recorded here so that phase 1's schema is designed with it
  rather than migrated for it afterwards.

### The blocking dependency

`putDocument` deletes every row in `document_sections` for the document and
re-inserts them:

```ts
await db.delete(documentSections)
  .where(eq(documentSections.documentId, document.id));
```

Section ids are therefore new on every write, and `atoms.section_id` is
`on delete cascade` (`docs/04-data-model.md`). **Every re-upload of a document
deletes every atom projected from it.**

That is harmless in phase 0, where atoms are created by hand and there is no
extraction to speak of. It is intolerable under a daemon that uploads on every
save: a whitespace fix in one paragraph would discard a week of ratification
across the whole file, and the throughput of that ratification is a
first-class product metric (`docs/02-principles.md`, 5).

The fix belongs to phase 1, and this document states the requirement so phase
1 does not have to rediscover it. Sections are matched and updated, not
rebuilt:

1. Match by `section_hash` first. An unchanged section keeps its row and its
   id whatever its new ordinal — which is the whole reason the hash is
   content-based rather than position-based.
2. Then match the remainder by `(heading_path, ordinal)`, in ordinal order, so
   an edited section keeps its identity and its atoms are re-verified rather
   than destroyed.
3. Unmatched incoming sections are inserts. Unmatched existing sections are
   deletes, and those are the only deletes that should cascade to atoms.

**Until that lands, the daemon must not ship.** `standfast doc push` is a
developer typing a command and watching the result; a daemon is the same
destructive write, unattended, on every keystroke that reaches disk.

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
control left: the body is stored, and once phase 1 exists it is sectioned,
extracted, embedded, and eligible to be quoted into another agent's context
pack.

The controls, in the order they fire:

| # | Control | Fires |
| --- | --- | --- |
| 1 | include-only globs, no `exclude` | before any read |
| 2 | plan-then-confirm on a new or widened list | before any read |
| 3 | the allowlist gates the read | before any read |
| 4 | symlinks not followed, escaping paths refused | before any read |
| 5 | first upload of a path reported distinctly from an update | at the send |
| 6 | `sync prune` / `doc rm`, and the cascade | after |

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

**Not settled.** `docs/03-architecture.md` already lists where the daemon
lives — its own package, or a mode of the CLI — as open, and the trigger
question is the same question seen from the other end. Both are in *Open*
below, with the trade-offs, because `plan()` being a pure function means
nothing is blocked by leaving them there.

What is settled regardless of the answer: it is Apache-2.0, it reaches the
server through `@standfast/sdk` over HTTPS and never touches Postgres, it
authenticates with an API key like any other client, and it holds the journal
and the confirmed-scope digest locally beside the CLI's own configuration
(`XDG_CONFIG_HOME`, as `packages/cli/src/config.ts` resolves it today).

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

- **The trigger.** Four candidates, none settled:

  | Shape | For | Against |
  | --- | --- | --- |
  | Long-running watcher | lowest staleness; a real local loop | a process to install, supervise and debug; dies silently; runs when nobody is watching, which is the condition the privacy controls are weakest under |
  | Git hook (`post-commit`, `post-checkout`) | syncs content that already passed review; provenance for free | misses uncommitted edits; per-clone, so it is a per-developer setting (`core.hooksPath`) and trivially bypassed |
  | CI step on the default branch | one place, one credential, auditable; syncs what actually merged, which is the better definition of "what governs the project" | staleness measured in the length of a CI run; no local loop at all |
  | CLI one-shot (`standfast sync`) | nothing to operate; closest to what exists | relies on someone remembering |

  These are not exclusive — the CLI one-shot is the primitive the hook and the
  CI step would both call. The open question is which one is the default we
  document and support.
- **Where it lives** — its own package, or a mode of `packages/cli`. The same
  open item as `docs/03-architecture.md`. A separate package is right if the
  watcher ships and overhead if the answer is a CLI one-shot, so this question
  resolves with the one above rather than before it.
- **The debounce window and the bulk-absence fraction.** Both are numbers, and
  neither has been measured. Inventing them here is the failure
  `docs/02-principles.md` (10) describes.
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
- **Reading remote state cheaply.** The daemon needs `(path, content_hash)`
  per document; `GET /v1/projects/{projectId}/documents` returns every
  document in full, bodies included, unpaginated. That is fine at phase-0
  scale, and it is the same gap `docs/03-architecture.md` already lists under
  pagination. Whether the answer is pagination, a projection parameter, or a
  dedicated manifest endpoint is open.
- **Behaviour when the API is unreachable.** A one-shot run should fail
  loudly; a watcher should retry with backoff. Since that answer is a function
  of the trigger, it resolves with the trigger.
- **The config file's name and shape** — `standfast.sync.json`, or a key inside a
  broader `standfast.json` that later holds other project settings — and whether
  one folder may serve more than one project.
- **A size cap on an individual document.** A Markdown file can contain a
  base64 blob. Nothing today refuses one, and the body column is `text`.

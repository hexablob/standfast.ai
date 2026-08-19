<!-- docs/08-mcp-server.md -->
# MCP server

> **Status: the catalogue is settled. The implementations are phase-gated.**
> The tool names, their modes and their response envelopes below are a public
> contract and are implemented as each phase lands. A tool marked *phase 2* is
> not to be stubbed out earlier — an agent that calls a tool returning nothing
> learns not to call it again.

## Why this document exists before the code

A tool name is harder to change than an HTTP endpoint. It lives in every user's
client configuration, in shell aliases, in blog posts, and in the habits a
model forms about which tool to reach for. An endpoint can be versioned behind
a redirect; a renamed tool is a broken session for everyone at once.

`CLAUDE.md` treats ten tools as a hard cap and requires the per-session token
cost to be discussed before an eleventh is added. This document is that
discussion, held once, in advance.

## The budget is the design constraint

Every tool description is sent on every request of every session, in every
client, forever. It is the only part of the system whose cost is paid even when
nobody uses it.

Two consequences, both from `docs/02-principles.md` (3):

- **Mode-bearing tools, not single-purpose ones.** One `read` with a `kind`
  parameter beats three tools called `read_atom`, `read_document` and
  `read_section`. Same capability, a third of the description, and a smaller
  menu for the model to choose badly from.
- **The cap is a budget, not a target.** This catalogue defines **six** tools
  and leaves four unspent. Filling the remaining slots is not an achievement.

**Contract:** the serialised tool descriptions stay under **1 200 tokens** in
total. Exceeding it fails the build, in the same way an OpenAPI drift fails it.

The enforcement is a proxy and says so: `packages/mcp/src/budget.test.ts`
asserts a **4 800-character** ceiling, four characters per token being the
usual approximation for English prose. A real tokenizer would be a build-time
dependency for a check that has never been close to its limit. If it ever gets
close at the margin, the fix is a tokenizer, not a bigger number.

## The catalogue

| Tool | Purpose | Phase |
| --- | --- | --- |
| `context` | the governing atoms for the work in hand | 2 |
| `search` | find knowledge by query | 2 |
| `read` | one entity, with full provenance | **0** |
| `propose` | write a provisional atom | **0** |
| `reconcile` | submit verdicts about whether code honors atoms | 3 |
| `status` | what is pending, what is drifting | **0** |

Registered as the `standfast` server, so clients that namespace render these as
`mcp__standfast__context` and so on. Names are short deliberately; the server name
supplies the disambiguation, and paying for it twice is paying twice.

### `context` — phase 2

The cold-start killer, and the tool that earns the product.

Input: a task description, a list of file paths, or both. Output: the atoms
that govern that work, assembled under an explicit token budget.

- `scope`: `"file" | "task" | "project"`
- `budget_tokens`: caller-supplied, defaulting to a modest figure. The
  assembler respects it; it does not approximate it.
- **No generative model call.** Fusion and assembly are deterministic
  (`docs/02-principles.md`, 4). Latency and token count are contracts.
  `docs/06-retrieval.md` names the two exceptions it does admit — embedding the
  caller's query, and the cross-encoder reranker — and the five conditions each
  must meet. Both are pinned and reproducible; neither generates text. Under
  `scope: "file"` there is no free-text query and so no query embedding at all.

This is also the tool a `SessionStart` hook calls, which is what makes Standfast
work for an agent that never thinks to ask. See *Hooks* below.

### `search` — phase 2

Query-driven retrieval, for when the agent knows what it is looking for.

- `mode`: `"lexical" | "semantic" | "hybrid"` — default `"hybrid"`
- Returns atoms and the documents they project from.

### `read` — phase 0

One entity, in full, with its provenance.

- `kind`: `"atom" | "document" | "section"`
- Returns the source quote and the `document#section` it came from, always. An
  atom without visible provenance is an assertion, and the point of the
  projection invariant is that there are none.

### `propose` — phase 0

How an agent contributes. It writes a **provisional** atom and nothing else.

- `op`: `"create"` today. `"supersede"` arrives with the supersession
  lifecycle, which **phase 4 owns** — `docs/14-roadmap.md` puts "distribution
  and the ratification loop" there and `docs/15-ratification.md` says so of
  itself ("no queue, no reject route, no supersede route"). This line said
  phase 2 until phase 2 arrived without it; the roadmap owns phase boundaries,
  so the roadmap wins. The tool has no `op` parameter at all meanwhile, because
  a single-valued enum is a description everyone pays for and nobody uses.
- Requires `source_quote` and `source_span` pointing into an existing section.
  The database refuses otherwise; the tool schema refuses first, so the agent
  gets a sentence rather than a constraint violation.
- There is **no `status` parameter and no ratify tool**. Not "restricted" — 
  absent. An agent cannot promote its own knowledge, and the surface should not
  suggest otherwise.

### `reconcile` — phase 3

The moat. `docs/02-principles.md` (1): the value is knowing whether the code
still honors the decisions.

The agent reads the code — locally, in its own session — and submits verdicts.

- Input per item: `atom_id`, `verdict`, `file_path`, `line_start`, `line_end`,
  and an optional short rationale.
- **No field accepts code.** Not truncated, not hashed, not "just a snippet".
  This is invariant 3 enforced at the wire, and the schema is where it is
  enforced first (`docs/02-principles.md`, 2).
- Output is an acknowledgement and what it changed. The system flags and
  annotates; it does not fix code or open pull requests
  (`docs/02-principles.md`, 6).

### `status` — phase 0

The state of the knowledge base: how much is provisional, what is waiting on a
human, what reconciliation last said.

Ratification throughput is a first-class product metric, not an interface
detail (`docs/02-principles.md`, 5). A tool that surfaces the queue is what
lets an agent say "there are eleven atoms waiting on you" — which is the
cheapest thing that moves the actual bottleneck.

## Response envelope

Every list-returning tool wraps its results:

```jsonc
{
  "items": [ /* … */ ],
  "total": 47,
  "returned": 10,
  "truncated": true
}
```

That is the shape `packages/mcp/src/envelope.ts` emits today. A
`budget_tokens_used` field belongs with `context` in phase 2, when something
first spends a token budget; nothing counts tokens at runtime yet, and a field
that is always absent is a field agents learn to ignore.

`truncated` is mandatory: the caller is never left to infer it from
`returned < total`.
`docs/02-principles.md` anti-patterns: *do not return a truncated result set
without telling the agent it was truncated.* An agent that believes it has seen
everything reasons confidently and wrongly, which is worse than an agent that
knows it is missing something.

## What is deliberately absent

Each of these was considered and rejected. Recorded so the question is asked
once.

- **`ratify`** — an agent cannot promote its own knowledge. The absence is the
  design.
- **Document writing** (`put_document`, `delete_document`) — documents enter
  through the sync daemon watching the customer's folder
  (`docs/10-sync-daemon.md`), not through an agent call. The folder stays the
  working surface (`docs/01-thesis.md`, *what Standfast is not*). Two write paths
  into the same source would mean two ways for it to disagree with itself.
- **`export`** — anti-lock-in matters (`docs/02-principles.md`, 11), but it is
  a human operation, not something an agent does mid-task. It belongs to the
  CLI, where it costs no session tokens.
- **Project and org management** — CLI and dashboard. An agent works inside one
  project; choosing between projects is not its job.
- **Anything that returns source code.** There is no tool for it because there
  is no representation of it (`docs/01-thesis.md`).

## Hooks, and why MCP alone is not enough

MCP is **pull**: the model decides whether to call a tool. That is the right
shape for `search` and `read`, and the wrong shape for cold start — an agent
that never calls `context` gets none, and rediscovers the conventions by
violating one, which is the exact failure this product exists to fix.

Claude Code hooks are **push**: deterministic shell commands on lifecycle
events, which fire whether or not the model wants them.

| Event | Use |
| --- | --- |
| `SessionStart` | inject the project's canonical atoms |
| `UserPromptSubmit` | inject what governs the stated task |
| `PostToolUse` after `Edit`/`Write` | queue reconciliation for the changed file |

Hooks inject; they never block. *"The context pack informs the work; it never
gates it"* (`docs/01-thesis.md`).

The distribution consequence: for Claude Code, Standfast ships as a **plugin**
bundling the MCP server and these hooks together. For Cursor, Codex, Gemini and
the rest, it ships as a plain MCP server — which is what makes the
tool-divergence claim in the thesis true rather than aspirational. Hooks are an
enhancement on one client; MCP is the promise.

## Open

- Whether `context` should accept a diff rather than file paths, once
  reconciliation exists.
- Whether `status` folds into `context` as a mode. It would save a slot; it
  would also make the most-called tool in the system heavier for every caller
  that does not want it.
- Registry namespace: `ai.standfast/*`, which the `standfast.ai` domain authenticates.

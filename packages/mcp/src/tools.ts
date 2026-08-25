import { z } from "zod";

/**
 * The catalogue, as settled in docs/08-mcp-server.md.
 *
 * Six tools are specified there, and all six now live here. `context` and
 * `search` joined the three phase-0 tools when retrieval landed; `reconcile`
 * arrived with phase 3, which is the first time this server can be told whether
 * the code still honors what the project decided.
 *
 * Six of ten, and this is the last one the specification names. The four
 * unspent slots stay unspent — the cap is a budget (`docs/02-principles.md`, 3),
 * and spending it is not an achievement.
 *
 * Descriptions are terse on purpose. Every one is sent on every request of
 * every session, in every client, forever — the only cost in the system paid
 * even when nobody uses it. `budget.test.ts` fails the build if the total
 * grows past the agreed ceiling.
 */

export const READ_INPUT = {
  kind: z
    .enum(["atom", "document", "section"])
    .describe("Which kind of entity to read."),
  id: z.uuid().describe("Its id."),
};

export const PROPOSE_INPUT = {
  projectId: z.uuid().describe("Project the atom belongs to."),
  documentId: z.uuid().describe("Document the statement is drawn from."),
  sectionId: z.uuid().describe("Section within that document."),
  statement: z
    .string()
    .min(1)
    .max(2000)
    .describe("The decision, convention or constraint, in one sentence."),
  kind: z
    .enum(["decision", "convention", "constraint"])
    .describe("What sort of knowledge this is."),
  sourceQuote: z
    .string()
    .min(1)
    .describe("Text quoted verbatim from the section that supports it."),
  sourceSpan: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .describe("Character offsets of the quote within the section."),
};

export const STATUS_INPUT = {
  projectId: z.uuid().describe("Project to report on."),
};

export const CONTEXT_INPUT = {
  projectId: z.uuid().describe("Project to draw from."),
  scope: z
    .enum(["file", "task", "project"])
    .default("task")
    .describe(
      "What the work is: named files, a described task, or the whole project.",
    ),
  query: z
    .string()
    .max(4000)
    .optional()
    .describe("What you are about to do, in your own words."),
  paths: z
    .array(z.string().max(1024))
    .max(64)
    .default([])
    .describe("Files the work touches."),
  budgetTokens: z
    .number()
    .int()
    .min(0)
    .max(200_000)
    .default(2000)
    .describe("Ceiling for the pack. Respected, not approximated."),
};

export const SEARCH_INPUT = {
  projectId: z.uuid().describe("Project to search."),
  query: z.string().min(1).max(4000).describe("What you are looking for."),
  mode: z
    .enum(["lexical", "semantic", "hybrid"])
    .default("hybrid")
    .describe("Exact wording, meaning, or both."),
  limit: z.number().int().min(1).max(100).default(20),
};

/**
 * The verdict vocabulary, and the rationale cap, written out rather than
 * imported.
 *
 * `@standfast/core` owns both, and this file deliberately does not import it:
 * this package is Apache-2.0 and core is AGPL-3.0-only, so an import here would
 * quietly relicense the MCP server. Same trade as `hooks.ts` makes, for the
 * same reason. The API refuses anything these four literals do not cover, so
 * the copy cannot drift silently — it can only be *stricter* here, never looser.
 */
export const RECONCILE_INPUT = {
  projectId: z.uuid().describe("Project the atoms belong to."),
  trigger: z
    .enum([
      "post_edit",
      "session_end",
      "explicit",
      "agent",
      "atom_ratified",
      "stale",
    ])
    .default("agent")
    .describe("Which loop produced this check. Recorded, never acted on."),
  items: z
    .array(
      // `.strict()` on the item, and it is load-bearing rather than tidy. The
      // MCP SDK wraps this shape in a plain `z.object(...)`, which *strips*
      // unknown keys — so without this an agent that attached a `snippet` would
      // have it silently dropped and would be told the call succeeded, which is
      // the worst of the three possible outcomes: it looks like acceptance, so
      // the agent keeps doing it. The API refuses the same field server-side;
      // this is what turns a silent drop into an error the agent can read.
      z
        .object({
          atomId: z.uuid().describe("The atom you checked."),
          verdict: z
            .enum(["honored", "violated", "not_applicable", "unverifiable"])
            .describe(
              "violated: you found lines that disprove it. honored: you looked and found none. not_applicable: it does not govern this file. unverifiable: reading code cannot decide it.",
            ),
          filePath: z
            .string()
            .min(1)
            .max(1024)
            .describe("Repository-relative path you read. Never absolute."),
          lineStart: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(
              "Required for violated: the first line that disproves it.",
            ),
          lineEnd: z.number().int().min(1).optional(),
          rationale: z
            .string()
            .max(280)
            .optional()
            .describe("One short line, for the human. No code, no newlines."),
        })
        .strict(),
    )
    .min(1)
    .max(64)
    .describe("Every verdict from this check, in one call."),
};

/**
 * `status` and `propose` carry the two sentences that stop an agent forming a
 * wrong model of the system, so they are worth their tokens:
 *
 * - propose says the atom is provisional and that the agent cannot ratify it.
 *   Without that, an agent retries, invents a ratify call, or reports success
 *   it did not achieve.
 * - status names the human queue, which is the actual bottleneck the product
 *   is trying to move.
 */
export const DESCRIPTIONS = {
  read: "Read one atom, document or section from Standfast, with the source quote it was drawn from.",
  propose:
    "Propose a decision, convention or constraint. It is stored as provisional and must quote the text it came from. Only a human can ratify it; you cannot.",
  status:
    "Summarise a project's knowledge: how many atoms are provisional, canonical or rejected, and how many are waiting on a human to ratify.",
  // Two sentences, and the second one is the one that earns its tokens: an
  // agent that does not know the pack is bounded will ask again for the rest.
  context:
    "Get the ratified decisions, conventions and constraints that govern the work you are about to do. Returns a set assembled under your token budget, ordered constraints first; `truncated` says whether anything was left out.",
  search:
    "Search a project's ratified knowledge by wording, by meaning, or both, and get back the documents it projects from.",
  // The second sentence is the one that earns its tokens. An agent that has
  // just read source and is asked to report on it will try to paste a snippet
  // unless told, in the description it always sees, that the field does not
  // exist.
  reconcile:
    "Submit verdicts on whether code you have just read still honors the atoms that govern it. No field accepts code \u2014 a verdict, a path and line numbers only, and a violation must cite the lines that disprove the atom.",
} as const;

export const TITLES = {
  read: "Read knowledge",
  propose: "Propose knowledge",
  status: "Knowledge status",
  context: "Governing knowledge",
  search: "Search knowledge",
  reconcile: "Reconcile code with knowledge",
} as const;

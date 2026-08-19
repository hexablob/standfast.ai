/**
 * Facts about the project that more than one page states. Copy that appears
 * twice belongs here so the two copies cannot drift apart — the same rule the
 * rest of this repository applies to its own documentation.
 */

export const REPO = "https://github.com/hexablob/standfast.ai";

export const doc = (file: string) => `${REPO}/blob/main/docs/${file}`;

export const NAV = [
  { href: "/how-it-works/", label: "How it works" },
  { href: "/principles/", label: "Principles" },
  { href: "/roadmap/", label: "Roadmap" },
] as const;

/** Read out of `docs/14-roadmap.md`, not out of an ambition. */
export const STATUS = {
  chip: "Phases 1 and 2 under way",
  line: "Phase 0 complete. Phases 1 and 2 have shipped their machinery and both wait on the same thing: a labelled corpus, written blind by a human, that does not exist yet.",
} as const;

export const INVARIANTS = [
  {
    n: "01",
    title: "Atoms are a projection of documents",
    body: "Knowledge is extracted from versioned prose, never hand-minted. Every atom carries a quote that verifiably appears in the section it names, so it can be re-derived when models improve and always cites its source.",
  },
  {
    n: "02",
    title: "Everything an agent writes is born provisional",
    body: "Human ratification is what makes the knowledge base worth querying. It is the mechanism that produces trust, not friction to be optimised away. There is no ratify tool, and a composite foreign key means the database would refuse even if there were.",
  },
  {
    n: "03",
    title: "Source code never leaves the machine",
    body: "Reconciliation runs inside your own agent session. What comes back is a verdict and a path:line pointer, nothing else. Enforced in the schema and in the database, not promised in a policy.",
  },
] as const;

export const TOOLS = [
  {
    name: "context",
    purpose: "the governing atoms for the work in hand",
    phase: "2",
  },
  { name: "search", purpose: "find knowledge by query", phase: "2" },
  { name: "read", purpose: "one entity, with full provenance", phase: "0" },
  { name: "propose", purpose: "write a provisional atom", phase: "0" },
  {
    name: "reconcile",
    purpose: "submit verdicts about whether code honors atoms",
    phase: "3",
  },
  { name: "status", purpose: "what is pending, what is drifting", phase: "0" },
] as const;

export const NUMBERS = [
  {
    metric: "Extraction precision",
    owner: "Phase 1",
    note: "of the atoms extracted, how many are real decisions",
  },
  {
    metric: "Retrieval precision under budget",
    owner: "Phase 2",
    note: "with the token budget fixed, not relaxed to flatter the result",
  },
  {
    metric: "Reconciliation false-positive rate",
    owner: "Phase 3",
    note: "the kill metric — above 5%, users switch the feature off for good",
  },
  {
    metric: "Ratification throughput",
    owner: "Phase 4",
    note: "the real bottleneck, so a first-class product metric",
  },
] as const;

export const PHASES = [
  {
    n: "0",
    scope: "Foundation: schema, auth, CRUD, SDK, CLI, three MCP tools",
    owns: "—",
    state: "complete",
  },
  {
    n: "1",
    scope: "Extraction: documents become provisional atoms",
    owns: "Extraction precision",
    state: "under way",
  },
  {
    n: "2",
    scope: "Retrieval: context and search under a token budget",
    owns: "Retrieval precision under budget",
    state: "under way",
  },
  {
    n: "3",
    scope: "Reconciliation: verdicts on whether code honors atoms",
    owns: "Reconciliation false-positive rate",
    state: "not started",
  },
  {
    n: "4",
    scope: "Distribution and the ratification loop",
    owns: "Ratification throughput",
    state: "not started",
  },
  {
    n: "5",
    scope: "Teams",
    owns: "Nothing new; nothing may regress",
    state: "not started",
  },
] as const;

export const ALTERNATIVES = [
  {
    approach: "AGENTS.md and a sync script",
    does: "one canonical file, generated into each tool's format",
    doesNot: "tell you when the code stopped matching the file",
  },
  {
    approach: "Rule generators",
    does: "keep CLAUDE.md, .cursor/rules and friends in step",
    doesNot: "scope per file, or verify anything",
  },
  {
    approach: "Agent memory services",
    does: "remember across sessions, served over MCP",
    doesNot:
      "separate a decision from a passing remark, or require a human to ratify either",
  },
  {
    approach: "Injection proxies",
    does: "put context into the model request",
    doesNot: "leave an auditable record of what governs what",
  },
] as const;

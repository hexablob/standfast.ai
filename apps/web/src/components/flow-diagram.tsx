import { Badge } from "@/components/ui";

type Lane = {
  id: string;
  label: string;
  note: string;
  phase: string;
  steps: ReadonlyArray<{ title: string; detail: string; accent?: boolean }>;
};

const LANES: readonly Lane[] = [
  {
    id: "write",
    label: "Write path",
    note: "Model calls live here, on the way in — never between a question and its answer.",
    phase: "Phase 1",
    steps: [
      {
        title: "Markdown you already wrote",
        detail: "pushed, versioned, yours",
      },
      {
        title: "Sections",
        detail: "hash-diffed, so an edit re-extracts only what moved",
      },
      { title: "Candidate atoms", detail: "each carrying a verbatim quote" },
      {
        title: "Quote verification",
        detail: "quote ≠ source → the atom is refused",
        accent: true,
      },
      { title: "Provisional", detail: "until a human ratifies it" },
    ],
  },
  {
    id: "read",
    label: "Read path",
    note: "Deterministic. Pinned, bounded embedding and reranking; nothing that generates text.",
    phase: "Phase 2",
    steps: [
      { title: "Agent opens a file", detail: "or asks a question" },
      {
        title: "context / search",
        detail: "two MCP tools, one response envelope",
      },
      {
        title: "Four generators, fused",
        detail: "vector, lexical, trigram, graph",
      },
      {
        title: "Assembled to a budget",
        detail: "token budget and p95 are contracts",
        accent: true,
      },
      {
        title: "Only what governs this file",
        detail: "with a truncated flag when it was",
      },
    ],
  },
  {
    id: "verify",
    label: "Verification",
    note: "The part none of the alternatives touch, and the only part worth building a company around.",
    phase: "Phase 3",
    steps: [
      { title: "Your agent reads the code", detail: "inside your own session" },
      { title: "reconcile", detail: "the agent submits a verdict" },
      {
        title: "Verdict + path:line",
        detail: "no contents, no AST, no file tree",
        accent: true,
      },
      { title: "Drift is flagged", detail: "recommender, never actor" },
      {
        title: "A human decides",
        detail: "Standfast does not open the pull request",
      },
    ],
  },
];

function Arrow() {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center text-line"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[16px] rotate-90 lg:rotate-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        <path d="M5 12h13m-5-5 5 5-5 5" />
      </svg>
    </span>
  );
}

export function FlowDiagram() {
  return (
    <div className="grid gap-md">
      {LANES.map((lane) => (
        <div
          key={lane.id}
          className="rounded-lg border border-line bg-neutral p-lg pb-[28px]"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-sm">
            <h3 className="text-h3 text-primary">{lane.label}</h3>
            <Badge>{lane.phase}</Badge>
          </div>
          <p className="mt-xs max-w-[70ch] text-body-sm text-muted">
            {lane.note}
          </p>

          <ol className="mt-md flex flex-col lg:flex-row lg:items-stretch">
            {lane.steps.map((step, i) => (
              <li
                key={step.title}
                className="flex flex-col lg:flex-1 lg:flex-row lg:items-stretch"
              >
                <div
                  className={
                    step.accent
                      ? "h-full flex-1 rounded-md border border-secondary bg-surface p-sm"
                      : "h-full flex-1 rounded-md border border-line bg-surface p-sm"
                  }
                >
                  <p
                    className={
                      step.accent
                        ? "text-body-sm font-medium text-secondary"
                        : "text-body-sm font-medium text-primary"
                    }
                  >
                    {step.title}
                  </p>
                  <p className="mt-[2px] text-caption normal-case tracking-normal text-muted">
                    {step.detail}
                  </p>
                </div>
                {i < lane.steps.length - 1 ? (
                  <div className="flex items-center justify-center py-xs lg:px-xs lg:py-0">
                    <Arrow />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

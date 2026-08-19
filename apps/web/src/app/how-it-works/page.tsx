import type { Metadata } from "next";
import { FlowDiagram } from "@/components/flow-diagram";
import {
  ButtonLink,
  Card,
  Chip,
  Code,
  Container,
  Section,
  SectionHead,
} from "@/components/ui";
import { doc } from "@/lib/site";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Documents become sections, sections become quote-verified atoms, atoms stay provisional until a human ratifies them, and retrieval assembles a context pack under a fixed token budget. No generative model call sits between an agent's question and its answer.",
};

const STAGES = [
  {
    n: "01",
    title: "You push Markdown you already wrote",
    body: (
      <>
        Standfast is not a wiki and not an editor. Documents are plain Markdown
        in a store, and your folder stays the working surface. A push writes the
        document and enqueues extraction <em>inside the same transaction</em> —
        a job that survives a rolled-back write is a job that extracts from a
        document that does not exist.
      </>
    ),
  },
  {
    n: "02",
    title: "Sections are hashed, so an edit re-extracts only what moved",
    body: (
      <>
        A document is split into sections and each section is hashed. Re-running
        extraction over an unchanged project enqueues zero jobs — that is an
        exit criterion, not an optimisation. An extraction-state table records
        which section hash was extracted by which model version, so “when models
        improve, everything regenerates” is a query rather than an
        archaeological dig.
      </>
    ),
  },
  {
    n: "03",
    title: "Candidate atoms must quote their source, verbatim",
    body: (
      <>
        Extraction proposes atoms, each carrying a quote and a span. The quote
        is compared against the section body at that span — offsets counted in
        Unicode code points, not bytes — and an atom whose quote does not match
        is refused by a database trigger. Anti-hallucination here is a string
        comparison, not a confidence score.
      </>
    ),
  },
  {
    n: "04",
    title: "Deduplication happens at settled bands",
    body: (
      <>
        Atoms are embedded at 1024 dimensions. Below cosine 0.80 they are
        distinct; above 0.93 they merge; only the band between the two costs a
        judge call. Vector similarity is not claim identity, so the ambiguous
        middle is the only place a model is asked.
      </>
    ),
  },
  {
    n: "05",
    title: "Everything lands provisional",
    body: (
      <>
        Nothing an agent writes becomes canonical on its own. There is no ratify
        tool on the MCP surface, and a composite foreign key means the database
        would refuse even if there were. Ratification throughput is a
        first-class product metric, because it is the real bottleneck.
      </>
    ),
  },
] as const;

const RETRIEVAL = [
  {
    title: "Four candidate generators",
    body: "Vector search over an HNSW index at 1024 dimensions, lexical search over tsvector, fuzzy matching over pg_trgm, and graph expansion. Four ways to be wrong differently.",
  },
  {
    title: "Fused, then reranked",
    body: "Reciprocal rank fusion at k=60, then a cross-encoder reranker. Both are pinned and bounded; neither generates text.",
  },
  {
    title: "Assembled to a budget",
    body: "The context pack is assembled under an explicit token budget with MMR at λ≈0.7. The budget and p95 latency are contracts, not targets.",
  },
  {
    title: "Truncation is declared",
    body: "The truncated flag is set by the generator that truncated, never inferred from returned < total. An agent that is silently given a partial answer reasons confidently from a partial answer.",
  },
] as const;

export default function HowItWorksPage() {
  return (
    <>
      <section className="border-b border-line bg-neutral py-xl">
        <Container>
          <div className="max-w-[72ch] space-y-md">
            <Chip>The mechanism</Chip>
            <h1 className="text-h1 text-balance text-primary sm:text-display">
              Documents in, a governed context pack out, a verdict back.
            </h1>
            <p className="text-body-lg text-muted">
              Three paths, and the boundary between them is the whole design.
              Model calls live on the way in. The read path is deterministic.
              Verification runs on your machine and returns a sentence and a
              pointer.
            </p>
          </div>
        </Container>
      </section>

      <Section>
        <SectionHead
          eyebrow="At a glance"
          title="The whole system on one screen."
          lede="Each lane below is owned by one phase, and the phase badge says which."
        />
        <div className="mt-lg">
          <FlowDiagram />
        </div>
      </Section>

      {/* ── Write path ───────────────────────────────────────── */}
      <Section tone="neutral" id="write-path">
        <SectionHead
          eyebrow="Write path"
          title="Extraction is strictly on the way in."
          lede="Everything expensive, everything non-deterministic, everything that calls a model happens before an agent ever asks a question."
        />
        <ol className="mt-lg grid gap-md md:grid-cols-2">
          {STAGES.map((stage) => (
            <Card as="li" key={stage.n} className="flex flex-col gap-sm">
              <span className="text-label-sm uppercase text-secondary">
                {stage.n}
              </span>
              <h3 className="text-h3 text-balance text-primary">
                {stage.title}
              </h3>
              <p className="text-body text-muted">{stage.body}</p>
            </Card>
          ))}
        </ol>
      </Section>

      {/* ── Read path ────────────────────────────────────────── */}
      <Section id="read-path">
        <div className="grid gap-lg lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <SectionHead
              eyebrow="Read path"
              title="Deterministic, or it is not a read path."
              lede="No generative model call sits between an agent’s question and its answer. The pipeline admits pinned, bounded embedding and reranking, and nothing that generates text."
            />
            <p className="mt-md max-w-[54ch] text-body text-muted">
              Two MCP tools use it. <Code>context</Code> answers “what governs
              the work in hand”. <Code>search</Code> answers “find knowledge by
              query”. Both return the same envelope, and cold start is handled
              by push — the <Code>SessionStart</Code> and{" "}
              <Code>UserPromptSubmit</Code> hooks — because MCP is pull and an
              agent cannot ask about a convention it has never heard of.
            </p>
          </div>

          <ul className="grid gap-xs">
            {RETRIEVAL.map((item) => (
              <li
                key={item.title}
                className="rounded-md border border-line bg-neutral p-md"
              >
                <h3 className="text-body font-medium text-primary">
                  {item.title}
                </h3>
                <p className="mt-xs text-body-sm text-muted">{item.body}</p>
              </li>
            ))}
          </ul>
        </div>

        <p className="mt-lg max-w-[70ch] text-body-sm text-muted">
          Every constant above — k=60, λ≈0.7, the candidate caps,{" "}
          <Code>ef_search</Code> — is still the default it arrived as. They are
          recalibrated against a real corpus or they are not calibrated at all,
          and the roadmap says so out loud rather than quietly shipping the
          guess.
        </p>
      </Section>

      {/* ── Verification ─────────────────────────────────────── */}
      <Section tone="ink" id="verification">
        <div className="grid gap-lg lg:grid-cols-[1fr_0.9fr]">
          <div>
            <p className="text-label-sm uppercase text-neutral/60">
              Verification
            </p>
            <h2 className="mt-sm text-h1 text-balance text-surface">
              The source stays on your machine. The verdict comes back.
            </h2>
            <p className="mt-sm max-w-[56ch] text-body-lg text-neutral/70">
              Reconciliation runs inside your own agent session. Your agent
              already has the file open; it reads the code, compares it against
              the atoms that govern that path, and submits a verdict through{" "}
              <Code>reconcile</Code>. What crosses the wire is a judgement and a{" "}
              <Code>path:line</Code> pointer.
            </p>
            <p className="mt-md max-w-[56ch] text-body text-neutral/70">
              Standfast holds no representation of source code — no contents, no
              AST, no call graph, no file tree. It is a guarantee you can
              attempt to break and watch fail, which is worth more than any
              policy statement.
            </p>
          </div>

          <div className="space-y-md">
            <div className="rounded-lg border border-neutral/40 p-lg">
              <h3 className="text-h3 text-surface">Recommender, never actor</h3>
              <p className="mt-xs text-body text-neutral/70">
                The system flags, proposes and annotates. It does not fix code,
                deprecate knowledge, or open pull requests. A false positive
                costs a human a glance; an autonomous fix costs them a revert —
                and above a 5% false-positive rate, people switch a feature off
                and never switch it back on.
              </p>
            </div>
            <div className="rounded-lg border border-neutral/40 p-lg">
              <h3 className="text-h3 text-surface">Falsify, don’t confirm</h3>
              <p className="mt-xs text-body text-neutral/70">
                For any verification, the question is what would disprove the
                claim, never what would support it. A verifier that looks for
                agreement finds it.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Egress ───────────────────────────────────────────── */}
      <Section tone="neutral" id="egress">
        <div className="grid gap-lg lg:grid-cols-[0.9fr_1.1fr]">
          <SectionHead
            eyebrow="What leaves the machine"
            title="Allowlist, never denylist — and it refuses at start-up."
          />
          <div className="max-w-[62ch] space-y-md text-body-lg">
            <p>
              The extraction model, the embedding provider and the dedup judge
              are each a configured entry with a pinned version. A destination
              that is not on the list is not called, and a worker configured to
              call one refuses to start rather than discovering the problem at
              runtime.
            </p>
            <p className="text-body text-muted">
              Every call is recorded per project before it is made, so “what
              left, for which project, to whom” is answered by{" "}
              <Code>standfast egress</Code> rather than by reading a source file
              or writing a SQL prompt. The control landed one phase ahead of the
              traffic, on purpose: retrofitting a start-up refusal onto a
              shipped worker is a breaking configuration change for every
              deployment that already worked.
            </p>
          </div>
        </div>

        <div className="mt-lg flex flex-wrap gap-sm">
          <ButtonLink variant="secondary" href={doc("05-extraction.md")}>
            Extraction, in full
          </ButtonLink>
          <ButtonLink variant="secondary" href={doc("06-retrieval.md")}>
            Retrieval, in full
          </ButtonLink>
          <ButtonLink variant="secondary" href={doc("13-threat-model.md")}>
            Threat model
          </ButtonLink>
        </div>
      </Section>
    </>
  );
}

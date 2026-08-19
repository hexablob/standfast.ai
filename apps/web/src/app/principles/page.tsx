import type { Metadata } from "next";
import {
  ButtonLink,
  Card,
  Chip,
  Container,
  Section,
  SectionHead,
} from "@/components/ui";
import { doc, INVARIANTS } from "@/lib/site";

export const metadata: Metadata = {
  title: "Principles",
  description:
    "Three founding invariants and thirteen design principles. They take precedence over implementation preference: a pull request that breaks one must say so and justify it.",
};

const PRINCIPLES = [
  {
    title: "The moat is verification, not storage",
    body: "Keeping a record of decisions is trivial. Knowing whether the code still honors them is not. Every engineering hour is prioritised against that sentence.",
  },
  {
    title: "Privacy boundaries are enforced at the wire",
    body: "A guarantee a user can attempt to break and watch fail is worth more than any policy statement. Schema constraint, database constraint, permanent regression test.",
  },
  {
    title: "The tool budget is a product constraint",
    body: "Every tool description costs tokens in every session and degrades the agent’s selection accuracy. Adding a tool is a design decision, not an addition.",
  },
  {
    title: "Determinism on the read path",
    body: "No generative model call between an agent’s question and its answer. Pinned, bounded embedding and reranking only. Token budget and p95 latency are contracts, not targets.",
  },
  {
    title: "Provisional by default",
    body: "Nothing an agent writes becomes canonical without human ratification. And because ratification is the real bottleneck, its throughput is a first-class product metric, not an interface detail.",
  },
  {
    title: "Recommender, never actor",
    body: "The system flags, proposes and annotates. It does not fix code, deprecate knowledge, or open pull requests.",
  },
  {
    title: "Re-derivability",
    body: "Documents are the source; atoms are a projection. When models improve, everything regenerates.",
  },
  {
    title: "Falsify, don’t confirm",
    body: "For any verification, ask what would disprove the claim, never what would support it.",
  },
  {
    title: "Allowlist, never denylist",
    body: "For anything that leaves the machine. A destination that is not on the list is not called, and the refusal happens at start-up.",
  },
  {
    title: "Measure before you tune",
    body: "The evaluation harness precedes optimisation. Reconciliation false-positive rate is the kill metric: above 5%, users switch the feature off and never switch it back on.",
  },
  {
    title: "Anti-lock-in is a feature",
    body: "Full Markdown export to a repository the customer controls removes a major purchase objection for very little engineering.",
  },
  {
    title: "The supply chain is product surface",
    body: "Pin, sign, attest. Never execute the latest published version at every startup.",
  },
  {
    title: "Knowledge is an instruction channel",
    body: "A canonical atom is a directive injected into every future session. Treat it as a security surface: provenance surfaced, imperative and meta patterns flagged, human ratification as the central control.",
  },
] as const;

const ANTI_PATTERNS = [
  "Accumulate MCP tools as needs arise.",
  "Put a generative model call on a hot path.",
  "Let an agent promote its own knowledge.",
  "Mistake vector similarity for claim identity.",
  "Tune a threshold without a labelled corpus.",
  "Return a truncated result set without telling the agent it was truncated.",
] as const;

export default function PrinciplesPage() {
  return (
    <>
      <section className="border-b border-line bg-neutral py-xl">
        <Container>
          <div className="max-w-[72ch] space-y-md">
            <Chip>What the product is not allowed to do</Chip>
            <h1 className="text-h1 text-balance text-primary sm:text-display">
              Three invariants, thirteen principles, and no exceptions granted
              quietly.
            </h1>
            <p className="text-body-lg text-muted">
              These take precedence over implementation preference. A pull
              request that breaks one must say so and justify it — which is a
              different thing from a rule nobody may break, and a more honest
              one.
            </p>
          </div>
        </Container>
      </section>

      {/* ── The invariants ───────────────────────────────────── */}
      <Section>
        <SectionHead
          eyebrow="Founding invariants"
          title="Everything else follows from these."
          lede="They are not preferences. A change that breaks one is not a change to Standfast, it is a different product."
        />
        <ul className="mt-lg grid gap-md md:grid-cols-3">
          {INVARIANTS.map((item) => (
            <Card as="li" key={item.n} className="flex flex-col gap-sm">
              <span className="text-label-sm uppercase text-secondary">
                {item.n}
              </span>
              <h2 className="text-h3 text-balance text-primary">
                {item.title}
              </h2>
              <p className="text-body text-muted">{item.body}</p>
            </Card>
          ))}
        </ul>
      </Section>

      {/* ── The thirteen ─────────────────────────────────────── */}
      <Section tone="neutral">
        <SectionHead
          eyebrow="Design principles"
          title="Thirteen rules that decide arguments."
          lede="Numbered, cited in code and in review, and quoted back at whoever wrote them — including us."
        />

        <ol className="mt-lg grid gap-xs">
          {PRINCIPLES.map((principle, i) => (
            <li
              key={principle.title}
              className="grid gap-sm rounded-lg border border-line bg-surface p-md sm:grid-cols-[64px_1fr] sm:items-start sm:p-lg"
            >
              <span className="text-h3 text-secondary tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h2 className="text-h3 text-balance text-primary">
                  {principle.title}
                </h2>
                <p className="mt-xs max-w-[76ch] text-body text-muted">
                  {principle.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* ── Anti-patterns ────────────────────────────────────── */}
      <Section tone="ink">
        <div className="grid gap-lg lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="text-label-sm uppercase text-neutral/60">
              Anti-patterns
            </p>
            <h2 className="mt-sm text-h1 text-balance text-surface">
              Six things this codebase will not do.
            </h2>
            <p className="mt-sm max-w-[52ch] text-body-lg text-neutral/70">
              Written down because every one of them is the locally reasonable
              choice at the moment somebody makes it.
            </p>
          </div>

          <ul className="grid gap-xs self-start">
            {ANTI_PATTERNS.map((item) => (
              <li
                key={item}
                className="flex items-start gap-sm rounded-md border border-neutral/40 p-md text-body text-neutral"
              >
                <span
                  aria-hidden="true"
                  className="mt-[7px] size-[7px] shrink-0 rounded-full bg-secondary"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section>
        <div className="flex flex-wrap items-center justify-between gap-md rounded-lg border border-line bg-neutral p-lg">
          <p className="max-w-[52ch] text-body-lg text-primary">
            The design set is fifteen documents, each with a status banner. Read
            the banner before inferring anything from the prose.
          </p>
          <div className="flex flex-wrap gap-sm">
            <ButtonLink href={doc("02-principles.md")}>
              The principles in full
            </ButtonLink>
            <ButtonLink variant="secondary" href={doc("01-thesis.md")}>
              The thesis
            </ButtonLink>
          </div>
        </div>
      </Section>
    </>
  );
}

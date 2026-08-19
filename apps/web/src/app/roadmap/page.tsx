import type { Metadata } from "next";
import {
  Badge,
  ButtonLink,
  Card,
  Chip,
  Code,
  Container,
  Section,
  SectionHead,
} from "@/components/ui";
import { doc, NUMBERS, PHASES, STATUS } from "@/lib/site";

export const metadata: Metadata = {
  title: "Roadmap",
  description:
    "Phase 0 is complete. Phases 1 and 2 have shipped their machinery and both wait on a labelled corpus that does not exist yet. Phases 3 to 5 are decided as scope and ordering; no code exists for any of them.",
};

const SHIPPED = [
  "Monorepo, seven packages, TypeScript project references built with tsc -b.",
  "Core schema with row-level security in the first migration, and a regression test that attempts to cross the tenant boundary and watches it fail.",
  "CRUD for projects, documents and atoms; auth; the generated OpenAPI artifact, committed so its diff is the guard against a breaking change.",
  "The Standfast CLI and full Markdown export.",
  "The extraction schema, the evaluation harness, the pg-boss queue, the worker and the pipeline.",
  "Retrieval machinery: the indexes, four candidate generators, fusion, assembly, and the context and search tools.",
  "The outbound allowlist, its start-up refusal, and a per-project record of what actually left.",
] as const;

const NOT_SHIPPED = [
  "Reconciliation. It is the point of Standfast and it is phase 3.",
  "The ratification loop and the sync daemon — phase 4.",
  "Teams — phase 5, and it owns no number: a team feature that moves one of the four moved it downwards.",
  "Any tuned constant. k=60, λ≈0.7, the candidate caps and ef_search are all still the defaults they arrived as.",
] as const;

export default function RoadmapPage() {
  return (
    <>
      <section className="border-b border-line bg-neutral py-xl">
        <Container>
          <div className="max-w-[72ch] space-y-md">
            <Chip dot="accent">{STATUS.chip}</Chip>
            <h1 className="text-h1 text-balance text-primary sm:text-display">
              A phase exits on a number somebody measured.
            </h1>
            <p className="text-body-lg text-muted">{STATUS.line}</p>
          </div>
        </Container>
      </section>

      {/* ── What a phase is ──────────────────────────────────── */}
      <Section>
        <SectionHead
          eyebrow="The rule"
          title="Machinery is not a phase."
          lede="A slice that leaves the product coherent when it lands states three things, and they are not the same thing."
        />
        <ul className="mt-lg grid gap-md md:grid-cols-3">
          <Card as="li">
            <h2 className="text-h3 text-primary">Scope</h2>
            <p className="mt-xs text-body text-muted">What is built.</p>
          </Card>
          <Card as="li">
            <h2 className="text-h3 text-primary">Done</h2>
            <p className="mt-xs text-body text-muted">
              The sentence a user could say afterwards that they could not say
              before. If nothing changes for a user, the phase was a refactor.
            </p>
          </Card>
          <Card as="li">
            <h2 className="text-h3 text-primary">Exit criterion</h2>
            <p className="mt-xs text-body text-muted">
              Something a machine can check. “Extraction works well” is not one.
              “Zero stored atoms whose quote does not verify against its
              section” is.
            </p>
          </Card>
        </ul>
        <p className="mt-md max-w-[76ch] text-body text-muted">
          Where an exit criterion needs a number nobody has measured yet, it
          says so and the number goes to <em>Open</em>. A roadmap that invents
          thresholds is a roadmap that will be quietly ignored the first time
          reality disagrees with it.
        </p>
      </Section>

      {/* ── The phases ───────────────────────────────────────── */}
      <Section tone="neutral" id="phases">
        <SectionHead
          eyebrow="Six phases"
          title="The numbers are a contract. They are not renumbered, ever."
          lede="Each of the four measurements belongs to exactly one phase, and that phase owns it."
        />

        <ol className="mt-lg grid gap-xs">
          {PHASES.map((phase) => (
            <li
              key={phase.n}
              className="grid gap-sm rounded-lg border border-line bg-surface p-md sm:grid-cols-[56px_1fr_auto] sm:items-center sm:p-lg"
            >
              <span className="inline-flex size-[40px] items-center justify-center rounded-full border border-line bg-neutral text-h3 text-primary">
                {phase.n}
              </span>
              <div className="min-w-0">
                <h2 className="text-h3 text-balance text-primary">
                  {phase.scope}
                </h2>
                <p className="mt-xs text-body-sm text-muted">
                  Owns: {phase.owns}
                </p>
              </div>
              <Badge
                tone={
                  phase.state === "complete"
                    ? "success"
                    : phase.state === "under way"
                      ? "accent"
                      : "muted"
                }
              >
                {phase.state}
              </Badge>
            </li>
          ))}
        </ol>
      </Section>

      {/* ── Shipped / not shipped ────────────────────────────── */}
      <Section>
        <div className="grid gap-md lg:grid-cols-2">
          <Card elevated className="border-line">
            <h2 className="text-h2 text-primary">What runs today</h2>
            <p className="mt-xs text-body text-muted">
              Read out of the repository, not out of a plan. Every phase-0 exit
              criterion is checked in CI.
            </p>
            <ul className="mt-md grid gap-sm">
              {SHIPPED.map((item) => (
                <li key={item} className="flex items-start gap-sm text-body">
                  <span
                    aria-hidden="true"
                    className="mt-[8px] size-[7px] shrink-0 rounded-full bg-success"
                  />
                  <span className="text-primary">{item}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card elevated className="border-line">
            <h2 className="text-h2 text-primary">What does not</h2>
            <p className="mt-xs text-body text-muted">
              Named here rather than left to be discovered on a Friday
              afternoon.
            </p>
            <ul className="mt-md grid gap-sm">
              {NOT_SHIPPED.map((item) => (
                <li key={item} className="flex items-start gap-sm text-body">
                  <span
                    aria-hidden="true"
                    className="mt-[8px] size-[7px] shrink-0 rounded-full bg-secondary"
                  />
                  <span className="text-primary">{item}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </Section>

      {/* ── The blocker ──────────────────────────────────────── */}
      <Section tone="ink">
        <div className="grid gap-lg lg:grid-cols-[1fr_0.9fr]">
          <div>
            <p className="text-label-sm uppercase text-neutral/60">
              The honest blocker
            </p>
            <h2 className="mt-sm text-h1 text-balance text-surface">
              Both open phases wait on the same missing thing.
            </h2>
            <p className="mt-sm max-w-[56ch] text-body-lg text-neutral/70">
              A labelled corpus, written blind by a human, before the first
              prompt is written or the first threshold is tuned. Three of the
              four bars are deliberately empty until it exists — a bar set
              against machinery that has not been measured is a bar nobody can
              defend.
            </p>
            <p className="mt-md max-w-[56ch] text-body text-neutral/70">
              The harness itself is built: the corpus format, the label format,
              the scoring functions and <Code>pnpm eval check</Code>, which runs
              with no model, no database and no network. What it does not have
              is labels, and no model may write them.
            </p>
          </div>

          <ul className="grid gap-xs self-start">
            {NUMBERS.map((item) => (
              <li
                key={item.metric}
                className="rounded-md border border-neutral/40 p-md"
              >
                <div className="flex items-baseline justify-between gap-sm">
                  <h3 className="text-body font-medium text-surface">
                    {item.metric}
                  </h3>
                  <span className="text-caption uppercase text-accent-ink">
                    {item.owner}
                  </span>
                </div>
                <p className="mt-xs text-body-sm text-neutral/70">
                  {item.note}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section>
        <div className="flex flex-wrap items-center justify-between gap-md rounded-lg border border-line bg-neutral p-lg">
          <p className="max-w-[54ch] text-body-lg text-primary">
            The roadmap in the repository carries the exit criteria in full,
            including the ones that are still open.
          </p>
          <div className="flex flex-wrap gap-sm">
            <ButtonLink href={doc("14-roadmap.md")}>
              Read the roadmap
            </ButtonLink>
            <ButtonLink variant="secondary" href={doc("12-evaluation.md")}>
              The evaluation harness
            </ButtonLink>
          </div>
        </div>
      </Section>
    </>
  );
}

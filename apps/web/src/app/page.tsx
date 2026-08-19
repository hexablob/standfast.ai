import Link from "next/link";
import {
  ContextScopeFigure,
  Figure,
  QuoteCheckFigure,
  WireFigure,
} from "@/components/figures";
import {
  Badge,
  ButtonLink,
  Card,
  Chip,
  Code,
  Container,
  cx,
  Eyebrow,
  Section,
  SectionHead,
  Terminal,
} from "@/components/ui";
import {
  ALTERNATIVES,
  doc,
  INVARIANTS,
  NUMBERS,
  PHASES,
  REPO,
  STATUS,
  TOOLS,
} from "@/lib/site";

const ATOM_FIELDS = [
  { label: "Source", value: "docs/03-architecture.md § Tenancy", mono: true },
  { label: "Governs", value: "packages/db/**", mono: true },
  { label: "Ratified by", value: "a human, not an agent", mono: false },
  {
    label: "Last verdict",
    value: "packages/db/migrations/0001.sql:14",
    mono: true,
  },
] as const;

function AtomCard() {
  return (
    <Card elevated className="relative w-full max-w-[440px] shadow-action">
      <div className="flex items-center justify-between gap-sm">
        <Badge>Atom · canonical</Badge>
        <span className="inline-flex items-center gap-xs text-caption uppercase text-muted">
          <span
            aria-hidden="true"
            className="size-[7px] rounded-full bg-success"
          />
          Honored
        </span>
      </div>

      <p className="mt-md text-h3 text-balance text-primary">
        “Row-level security is written in the first migration, not later.”
      </p>

      <dl className="mt-md space-y-sm border-t border-line pt-md text-body-sm">
        {ATOM_FIELDS.map((field) => (
          <div
            key={field.label}
            className="flex flex-col gap-[2px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-sm"
          >
            <dt className="shrink-0 text-muted">{field.label}</dt>
            <dd
              className={cx(
                "min-w-0 wrap-anywhere text-primary sm:text-right",
                field.mono && "font-mono",
              )}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-md text-caption uppercase text-muted">
        The quote is verbatim, or the atom does not exist
      </p>
    </Card>
  );
}

export default function HomePage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="border-b border-line bg-surface py-xl">
        <Container>
          <div className="grid items-center gap-xl lg:grid-cols-[1.15fr_1fr] [&>*]:min-w-0">
            <div className="space-y-md">
              <Chip dot="accent">{STATUS.chip}</Chip>

              <h1 className="text-h1 text-balance text-primary sm:text-display">
                Your agents keep relearning the same project.
              </h1>

              <p className="max-w-[56ch] text-body-lg text-muted">
                Every session your agent starts, it starts from nothing. It
                rediscovers the project’s conventions — usually by violating one
                and being corrected — and the correction is thrown away when the
                session ends. The next agent, on a different tool, repeats it.
              </p>

              <p className="max-w-[56ch] text-body-lg text-primary">
                Standfast holds a project’s decisions, conventions and
                constraints, serves each agent only what governs the file in
                front of it over MCP, and records whether the code still honors
                them.
              </p>

              <div className="flex flex-wrap items-center gap-sm pt-xs">
                <ButtonLink href={doc("01-thesis.md")}>
                  Read the thesis
                </ButtonLink>
                <ButtonLink variant="secondary" href={REPO}>
                  View the repository
                </ButtonLink>
              </div>

              <p className="pt-xs text-body font-medium text-primary">
                Agents read the code. Standfast keeps the verdict.{" "}
                <span className="text-secondary">
                  It never sees the source.
                </span>
              </p>
            </div>

            <div className="flex justify-center lg:justify-end">
              <AtomCard />
            </div>
          </div>
        </Container>
      </section>

      {/* ── The problem beneath the problem ──────────────────── */}
      <Section tone="neutral">
        <div className="grid gap-lg lg:grid-cols-[0.9fr_1.1fr]">
          <SectionHead
            eyebrow="The hard half"
            title="Keeping a record of a decision is easy. Knowing whether it is still true is not."
          />
          <div className="max-w-[62ch] space-y-md text-body-lg">
            <p>
              Sharing context between coding agents is a crowded space, and most
              of it solves storage and distribution — one canonical file, synced
              into every tool’s format, injected into every request.
            </p>
            <p>
              None of that answers the question that actually costs you an
              afternoon:{" "}
              <strong className="text-secondary">
                does the code still honor the decisions?
              </strong>{" "}
              That is the part Standfast is built for, and the only part worth
              building a company around.
            </p>
            <p className="text-body text-muted">
              Two consequences fall out of it. Nothing an agent writes becomes
              canonical on its own — knowledge is extracted from versioned
              prose, cited back to the sentence it came from, and stays
              provisional until a human ratifies it. And we never receive your
              source.
            </p>
          </div>
        </div>
      </Section>

      {/* ── The three invariants ─────────────────────────────── */}
      <Section>
        <SectionHead
          eyebrow="Founding invariants"
          title="Three sentences everything else follows from."
          lede="They are not preferences. A change that breaks one is not a change to Standfast, it is a different product."
        />
        <ul className="mt-lg grid gap-md md:grid-cols-3">
          {INVARIANTS.map((item) => (
            <Card as="li" key={item.n} className="flex flex-col gap-sm">
              <span className="text-label-sm uppercase text-secondary">
                {item.n}
              </span>
              <h3 className="text-h3 text-balance text-primary">
                {item.title}
              </h3>
              <p className="text-body text-muted">{item.body}</p>
            </Card>
          ))}
        </ul>
      </Section>

      {/* ── How it works ─────────────────────────────────────── */}
      <Section tone="neutral" id="how">
        <SectionHead
          eyebrow="The mechanism"
          title="One write path, one read path, and a verdict that comes back from your machine."
          lede="Documents are the source. Atoms are a projection of them. When models improve, everything regenerates."
        />

        <div className="mt-lg grid gap-md">
          <Figure
            eyebrow="Write path"
            title="An atom that cannot quote its source is not stored."
            phase="Phase 1"
            minWidth={720}
            caption={
              <>
                Extraction proposes; a database trigger disposes. The quote is
                compared against the section body at the span it names, with
                offsets counted in Unicode code points rather than bytes.
                Anti-hallucination here is a string comparison, not a confidence
                score — and because sections are hashed, an edit re-extracts
                only what actually moved.
              </>
            }
          >
            <QuoteCheckFigure />
          </Figure>

          <Figure
            eyebrow="Read path"
            title="Only what governs the file in front of you."
            phase="Phase 2"
            minWidth={780}
            caption={
              <>
                Four candidate generators — vector, lexical, trigram and graph —
                are fused, reranked and assembled into a pack that fits a fixed
                token budget. Nothing between the agent’s question and this
                answer generates text. When the pack does not fit, the flag is
                set by whatever truncated it, never inferred from a count.
              </>
            }
          >
            <ContextScopeFigure />
          </Figure>

          <Figure
            eyebrow="Verification"
            title="The boundary is a schema constraint, not a promise."
            phase="Phase 3"
            minWidth={780}
            caption={
              <>
                Your agent already has the file open. It reads the code inside
                your own session and submits a verdict; what crosses is a
                judgement and a <Code>path:line</Code>. Standfast holds no
                representation of source — no contents, no AST, no call graph,
                no file tree — and that is a guarantee you can attempt to break
                and watch fail.
              </>
            }
          >
            <WireFigure />
          </Figure>
        </div>

        <p className="mt-md text-body-sm text-muted">
          <Link
            href="/how-it-works/"
            className="text-secondary underline underline-offset-4"
          >
            The long version
          </Link>{" "}
          — the three paths end to end, the constants that are still defaults,
          and the outbound allowlist.
        </p>
      </Section>

      {/* ── The tool budget ──────────────────────────────────── */}
      <Section>
        <div className="grid gap-lg lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <SectionHead
              eyebrow="MCP surface"
              title="Six tools. The cap is ten, and four slots stay unspent."
              lede="Every tool description costs tokens in every session and degrades the agent’s selection accuracy. Adding one is a design decision, not an addition."
            />
            <p className="mt-md max-w-[56ch] text-body text-muted">
              An agent can propose knowledge; it cannot ratify it. There is no
              ratify tool, and the composite foreign key behind it means the
              database would refuse even if there were.
            </p>
          </div>

          <ul className="grid gap-xs sm:grid-cols-2">
            {TOOLS.map((tool) => (
              <li
                key={tool.name}
                className="rounded-md border border-line bg-neutral p-sm"
              >
                <div className="flex items-center justify-between gap-sm">
                  <code className="font-mono text-body font-medium text-primary">
                    {tool.name}
                  </code>
                  <Badge tone={tool.phase === "0" ? "success" : "muted"}>
                    {tool.phase === "0" ? "shipped" : `phase ${tool.phase}`}
                  </Badge>
                </div>
                <p className="mt-xs text-body-sm text-muted">{tool.purpose}</p>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── How this differs ─────────────────────────────────── */}
      <Section tone="neutral">
        <SectionHead
          eyebrow="Alternatives"
          title="What the neighbours do, and where they stop."
          lede="All good tools. All answering storage and distribution."
        />

        <div className="mt-lg overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <caption className="sr-only">
              How Standfast differs from adjacent approaches
            </caption>
            <thead>
              <tr className="border-b border-line">
                <th
                  scope="col"
                  className="p-md text-label-sm uppercase text-muted"
                >
                  Approach
                </th>
                <th
                  scope="col"
                  className="p-md text-label-sm uppercase text-muted"
                >
                  What it does
                </th>
                <th
                  scope="col"
                  className="p-md text-label-sm uppercase text-muted"
                >
                  What it does not do
                </th>
              </tr>
            </thead>
            <tbody>
              {ALTERNATIVES.map((row) => (
                <tr key={row.approach} className="border-b border-line">
                  <th
                    scope="row"
                    className="p-md align-top text-body font-medium text-primary"
                  >
                    {row.approach}
                  </th>
                  <td className="p-md align-top text-body text-muted">
                    {row.does}
                  </td>
                  <td className="p-md align-top text-body text-primary">
                    {row.doesNot}
                  </td>
                </tr>
              ))}
              <tr className="bg-neutral">
                <th
                  scope="row"
                  className="p-md align-top text-body font-medium text-secondary"
                >
                  Standfast
                </th>
                <td className="p-md align-top text-body text-muted">
                  scopes knowledge per file, keeps provenance, and records
                  whether the code still honors it
                </td>
                <td className="p-md align-top text-body text-primary">
                  see your source, or promote anything without a human
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── The four numbers ─────────────────────────────────── */}
      <Section tone="ink">
        <SectionHead
          eyebrow="How we will know it works"
          title="Not by atoms stored. By four numbers."
          className="[&_h2]:text-surface [&_p]:text-neutral/70"
        />
        <ul className="mt-lg grid gap-md md:grid-cols-2">
          {NUMBERS.map((item) => (
            <li
              key={item.metric}
              className="rounded-lg border border-neutral/40 p-lg"
            >
              <div className="flex items-baseline justify-between gap-sm">
                <h3 className="text-h3 text-surface">{item.metric}</h3>
                <span className="text-label-sm uppercase text-accent-ink">
                  {item.owner}
                </span>
              </div>
              <p className="mt-xs text-body text-neutral/70">{item.note}</p>
            </li>
          ))}
        </ul>
        <p className="mt-md max-w-[70ch] text-body text-neutral/70">
          Each number belongs to exactly one phase, and that phase owns it. The
          bars are not filled in yet, on purpose: a threshold invented before
          the corpus exists is a threshold that gets quietly ignored the first
          time reality disagrees with it.
        </p>
      </Section>

      {/* ── Honest status ────────────────────────────────────── */}
      <Section id="status">
        <div className="grid gap-lg lg:grid-cols-[1fr_1fr]">
          <div>
            <SectionHead
              eyebrow="Being straight about maturity"
              title="Reconciliation is the point of Standfast, and it is not built yet."
              lede={STATUS.line}
            />
            <p className="mt-md max-w-[56ch] text-body text-muted">
              The design set under <Code>docs/</Code> is written in full and
              almost none of it is built. Every document carries a status banner
              — <em>settled</em>, <em>designed, not implemented</em>, or{" "}
              <em>planned</em>. If you need something that works this afternoon,
              one of the tools above will serve you better, and we would rather
              say so than waste your evening.
            </p>
            <div className="mt-md">
              <ButtonLink variant="tertiary" href={doc("14-roadmap.md")}>
                Read the roadmap in the repository →
              </ButtonLink>
            </div>
          </div>

          <ol className="grid gap-xs">
            {PHASES.map((phase) => (
              <li
                key={phase.n}
                className="flex items-start gap-sm rounded-md border border-line bg-neutral p-sm"
              >
                <span className="mt-[2px] inline-flex size-[28px] shrink-0 items-center justify-center rounded-full border border-line bg-surface text-label-sm text-primary">
                  {phase.n}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-primary">
                    {phase.scope}
                  </p>
                  <p className="mt-[2px] text-body-sm text-muted">
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
        </div>
      </Section>

      {/* ── Get started ──────────────────────────────────────── */}
      <Section tone="neutral" id="start">
        <div className="grid gap-lg lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <SectionHead
              eyebrow="Getting started"
              title="Clone it, run it offline, read the argument."
              lede="pnpm test is green with no database — the integration tests self-skip. Nothing here calls a model without you configuring one."
            />
            <p className="mt-md max-w-[52ch] text-body text-muted">
              Export is a first-class feature, not a retention lever: full
              Markdown to a repository you control, at any time.
            </p>
          </div>

          <Terminal
            lines={[
              { comment: "# Node 26, per .nvmrc" },
              { cmd: "nvm use && pnpm install" },
              { cmd: "pnpm test" },
              { out: "  green with no database" },
              { comment: "" },
              { comment: "# then, against a local Postgres" },
              {
                cmd: "standfast login --key sf_sk_… --url http://localhost:8080",
              },
              { cmd: 'standfast project create "My project"' },
              { cmd: "standfast doc push docs/*.md --project <id>" },
              { cmd: "standfast export ./my-knowledge" },
              { out: "  full Markdown, yours to keep" },
            ]}
          />
        </div>
      </Section>

      {/* ── Closing ──────────────────────────────────────────── */}
      <Section>
        <div className="rounded-lg border border-line bg-neutral p-lg text-center md:p-xl">
          <Eyebrow className="text-center">Open source, two halves</Eyebrow>
          <h2 className="mx-auto mt-sm max-w-[24ch] text-h1 text-balance text-primary">
            Read the design set before you read the code.
          </h2>
          <p className="mx-auto mt-sm max-w-[60ch] text-body-lg text-muted">
            Fifteen documents, written in full, each one saying what is settled
            and what is not. It is the honest version of a product page.
          </p>
          <div className="mt-md flex flex-wrap justify-center gap-sm">
            <ButtonLink href={REPO}>Open the repository</ButtonLink>
            <ButtonLink variant="secondary" href={doc("02-principles.md")}>
              The thirteen principles
            </ButtonLink>
          </div>
        </div>
      </Section>
    </>
  );
}

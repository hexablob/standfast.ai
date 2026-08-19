import Link from "next/link";
import { Code, Container } from "@/components/ui";
import { doc, NAV, REPO } from "@/lib/site";

const DOCS = [
  { href: doc("01-thesis.md"), label: "Thesis" },
  { href: doc("02-principles.md"), label: "Design principles" },
  { href: doc("08-mcp-server.md"), label: "MCP server" },
  { href: doc("12-evaluation.md"), label: "Evaluation" },
  { href: doc("13-threat-model.md"), label: "Threat model" },
  { href: doc("14-roadmap.md"), label: "Roadmap" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-neutral py-xl">
      <Container>
        <div className="grid gap-lg md:grid-cols-[1.4fr_1fr_1fr]">
          <div className="max-w-[38ch] space-y-sm">
            <p className="text-h3 text-primary">
              Stand<span className="text-secondary">fast</span>
            </p>
            <p className="text-body text-muted">
              A shared knowledge layer for coding agents. Agents read the code.
              Standfast keeps the verdict. It never sees the source.
            </p>
          </div>

          <nav aria-label="Site" className="space-y-sm">
            <p className="text-label-sm uppercase text-muted">Site</p>
            <ul className="space-y-xs text-body">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-primary hover:text-secondary"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <a href={REPO} className="text-primary hover:text-secondary">
                  Repository
                </a>
              </li>
            </ul>
          </nav>

          <nav aria-label="Documents" className="space-y-sm">
            <p className="text-label-sm uppercase text-muted">Documents</p>
            <ul className="space-y-xs text-body">
              {DOCS.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="text-primary hover:text-secondary"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-lg space-y-sm border-t border-line pt-lg text-body-sm text-muted">
          <p className="max-w-[76ch]">
            Licensed in two halves, one repository.{" "}
            <strong className="text-primary">AGPL-3.0-only</strong> for{" "}
            <Code>api</Code>, <Code>core</Code>, <Code>db</Code> and{" "}
            <Code>worker</Code>;{" "}
            <strong className="text-primary">Apache-2.0</strong> for{" "}
            <Code>cli</Code>, <Code>mcp</Code> and <Code>sdk</Code> —
            integration surface with a copyleft obligation attached does not get
            integrated.
          </p>
        </div>
      </Container>
    </footer>
  );
}

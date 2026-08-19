import Link from "next/link";
import { ButtonLink, Container } from "@/components/ui";
import { NAV, REPO } from "@/lib/site";

function Mark() {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="size-[30px] shrink-0"
      focusable="false"
    >
      <rect width="32" height="32" rx="10" fill="var(--color-primary)" />
      <path
        d="M10 22.5h12M16 22.5V12"
        fill="none"
        stroke="var(--color-neutral)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="8.5" r="2.6" fill="var(--color-secondary)" />
    </svg>
  );
}

function Wordmark() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-sm text-h3 text-primary"
    >
      <Mark />
      <span>
        Stand<span className="text-secondary">fast</span>
      </span>
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-surface/92 backdrop-blur-sm">
      <Container className="flex h-[76px] items-center justify-between gap-md">
        <Wordmark />

        <nav
          aria-label="Primary"
          className="hidden items-center gap-lg md:flex"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-body text-muted transition-colors hover:text-primary"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-sm md:flex">
          <ButtonLink
            variant="secondary"
            href={REPO}
            className="h-[44px] px-md text-body"
          >
            GitHub
          </ButtonLink>
        </div>

        {/*
         * A native disclosure, so the mobile menu costs no JavaScript and
         * still opens with a keyboard. The page is otherwise fully static and
         * a hamburger is a poor reason to stop being.
         */}
        <details className="relative md:hidden">
          <summary className="flex size-[44px] cursor-pointer list-none items-center justify-center rounded-full border border-line text-primary [&::-webkit-details-marker]:hidden">
            <span className="sr-only">Menu</span>
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
              className="size-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <div className="absolute right-0 top-[calc(100%+14px)] w-[240px] rounded-lg border border-line bg-surface p-md shadow-action">
            <nav aria-label="Primary, compact" className="grid gap-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-body-lg text-primary"
                >
                  {item.label}
                </Link>
              ))}
              <a href={REPO} className="text-body-lg text-secondary">
                GitHub
              </a>
            </nav>
          </div>
        </details>
      </Container>
    </header>
  );
}

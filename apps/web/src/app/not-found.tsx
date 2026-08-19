import Link from "next/link";
import { ButtonLink, Container } from "@/components/ui";
import { REPO } from "@/lib/site";

export default function NotFound() {
  return (
    <Container>
      <div className="flex min-h-[60vh] max-w-[56ch] flex-col justify-center gap-md py-xl">
        <p className="text-label-sm uppercase text-muted">404</p>
        <h1 className="text-h1 text-balance text-primary">
          Nothing here, and we would rather say so than guess.
        </h1>
        <p className="text-body-lg text-muted">
          The page you asked for does not exist. The repository is the source of
          truth for everything this site summarises.
        </p>
        <div className="flex flex-wrap gap-sm pt-xs">
          <Link
            href="/"
            className="inline-flex h-[56px] items-center justify-center rounded-full bg-secondary px-[28px] text-label-lg font-medium text-surface shadow-action transition-colors hover:bg-tertiary"
          >
            Back to the start
          </Link>
          <ButtonLink variant="secondary" href={REPO}>
            Open the repository
          </ButtonLink>
        </div>
      </div>
    </Container>
  );
}

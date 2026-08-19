import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Small enough that a dependency for it would be the joke, not the helper. */
export const cx = (...parts: Array<string | false | undefined>) =>
  parts.filter(Boolean).join(" ");

export function Container({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("mx-auto w-full max-w-[1160px] px-md sm:px-lg", className)}
    >
      {children}
    </div>
  );
}

/**
 * The 96px section break is the page's rhythm. Every band uses it, which is
 * most of what makes the layout read as calm rather than merely spacious.
 */
export function Section({
  children,
  className,
  id,
  tone = "surface",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  tone?: "surface" | "neutral" | "ink";
}) {
  const tones = {
    surface: "bg-surface text-on-surface",
    neutral: "bg-neutral text-on-surface",
    ink: "bg-primary text-surface",
  } as const;

  return (
    <section id={id} className={cx("py-xl", tones[tone], className)}>
      <Container>{children}</Container>
    </section>
  );
}

export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cx("text-label-sm uppercase text-muted", className)}>
      {children}
    </p>
  );
}

export function Chip({
  children,
  dot,
}: {
  children: ReactNode;
  dot?: "success" | "accent";
}) {
  return (
    <span className="inline-flex items-center gap-xs rounded-full border border-line bg-surface px-[10px] py-xs text-label-sm uppercase text-primary">
      {dot ? (
        <span
          aria-hidden="true"
          className={cx(
            "size-[7px] rounded-full",
            dot === "success" ? "bg-success" : "bg-secondary",
          )}
        />
      ) : null}
      {children}
    </span>
  );
}

export function Badge({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "muted" | "success";
}) {
  const tones = {
    accent: "text-secondary",
    muted: "text-muted",
    success: "text-primary",
  } as const;

  return (
    <span
      className={cx(
        "inline-block rounded-full border border-line bg-surface px-[8px] py-[4px] text-caption uppercase",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className,
  elevated,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
  as?: "div" | "li" | "article";
}) {
  return (
    <Tag
      className={cx(
        "rounded-lg border border-line p-lg pb-[28px]",
        elevated ? "bg-surface" : "bg-neutral",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

type ButtonProps = ComponentPropsWithoutRef<"a"> & {
  variant?: "primary" | "secondary" | "tertiary";
};

export function ButtonLink({
  variant = "primary",
  className,
  children,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-sm text-label-lg font-medium transition-colors";
  const variants = {
    primary:
      "h-[56px] rounded-full bg-secondary px-[28px] text-surface shadow-action hover:bg-tertiary",
    secondary:
      "h-[56px] rounded-full border border-line bg-surface px-[28px] text-secondary hover:bg-neutral",
    tertiary:
      "text-body text-primary underline decoration-line underline-offset-4 hover:decoration-secondary hover:text-secondary",
  } as const;

  return (
    <a className={cx(base, variants[variant], className)} {...rest}>
      {children}
    </a>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-sm bg-neutral px-[6px] py-[2px] font-mono text-[0.92em] text-primary">
      {children}
    </code>
  );
}

/**
 * A terminal block. Static text, no copy button: a button that needs
 * JavaScript on an otherwise static page is a poor trade for saving one
 * keyboard shortcut.
 */
export function Terminal({
  lines,
  className,
}: {
  lines: ReadonlyArray<{ cmd?: string; out?: string; comment?: string }>;
  className?: string;
}) {
  return (
    <pre
      className={cx(
        "overflow-x-auto rounded-lg border border-line bg-primary p-lg font-mono text-body-sm leading-[24px] text-neutral",
        className,
      )}
    >
      <span aria-hidden="true" className="mb-md flex gap-xs">
        <span className="size-[9px] rounded-full bg-error" />
        <span className="size-[9px] rounded-full bg-secondary" />
        <span className="size-[9px] rounded-full bg-success" />
      </span>
      <code>
        {lines.map((line, i) => (
          <span
            // A transcript is fixed at build time, never reorders, and two of
            // its lines are allowed to read identically.
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the only stable identity a terminal line has
            key={`${line.cmd ?? line.comment ?? line.out ?? ""}-${i}`}
            className="block"
          >
            {line.comment ? (
              <span className="text-muted">{line.comment}</span>
            ) : line.cmd ? (
              <>
                <span className="text-secondary select-none">$ </span>
                <span>{line.cmd}</span>
              </>
            ) : (
              <span className="text-muted">{line.out}</span>
            )}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lede,
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("max-w-[68ch] space-y-sm", className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="text-h1 text-balance">{title}</h2>
      {lede ? <p className="text-body-lg text-muted">{lede}</p> : null}
    </header>
  );
}

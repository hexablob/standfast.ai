import type { ReactNode } from "react";
import { Badge } from "@/components/ui";

/*
 * Three drawings, one grammar.
 *
 * Everything is built from a handful of primitives — a box, a pill, a
 * connector, a kicker — over the palette already in `globals.css`. Nothing here
 * introduces a colour or a radius of its own. Copper marks exactly one idea per
 * drawing: whichever element the sentence beside it is about. Everything else
 * is plum at low opacity, which is what lets a dense picture still read as calm.
 *
 * Solid stroke means it happened. Dashed means it did not, or must not. That
 * distinction is load-bearing, so nothing else in these figures is dashed.
 */

const INK = "var(--color-primary)";
const LINE = "var(--color-line)";
const ACCENT = "var(--color-secondary)";
const MUTED = "var(--color-muted)";
const SURFACE = "var(--color-surface)";
const SUCCESS = "var(--color-success)";
const MONO = "var(--font-mono)";
const SANS = "var(--font-sans)";

type BoxProps = {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  accent?: boolean;
  dashed?: boolean;
  fill?: string;
  stroke?: string;
  strokeOpacity?: number;
};

function Box({
  x,
  y,
  w,
  h,
  r = 10,
  accent = false,
  dashed = false,
  fill = SURFACE,
  stroke,
  strokeOpacity,
}: BoxProps) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={r}
      fill={fill}
      stroke={stroke ?? (accent ? ACCENT : LINE)}
      strokeOpacity={strokeOpacity}
      strokeWidth={accent ? 1.5 : 1}
      strokeDasharray={dashed ? "4 4" : undefined}
    />
  );
}

type TextProps = {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  fill?: string;
  mono?: boolean;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  tracking?: number;
};

function T({
  x,
  y,
  children,
  size = 11,
  fill = INK,
  mono = false,
  weight = 400,
  anchor = "start",
  tracking,
}: TextProps) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fill={fill}
      fontFamily={mono ? MONO : SANS}
      fontWeight={weight}
      textAnchor={anchor}
      letterSpacing={tracking}
      dominantBaseline="middle"
    >
      {children}
    </text>
  );
}

/** A tracked micro-label. The only uppercase inside the drawings. */
function Kicker({
  x,
  y,
  children,
  anchor = "start",
  fill = MUTED,
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
  fill?: string;
}) {
  return (
    <T
      x={x}
      y={y}
      size={8.5}
      fill={fill}
      weight={500}
      anchor={anchor}
      tracking={1.4}
    >
      {children}
    </T>
  );
}

/** A kind marker: small enough to scan past, present enough to answer "what is this". */
function Pill({
  x,
  y,
  w,
  label,
}: {
  x: number;
  y: number;
  w: number;
  label: string;
}) {
  return (
    <>
      <rect
        x={x}
        y={y - 6.5}
        width={w}
        height={13}
        rx={6.5}
        fill="none"
        stroke={INK}
        strokeOpacity={0.22}
      />
      <T
        x={x + w / 2}
        y={y}
        size={7}
        mono
        fill={MUTED}
        weight={500}
        anchor="middle"
        tracking={0.7}
      >
        {label}
      </T>
    </>
  );
}

function Arrow({
  id,
  d,
  accent = false,
  dashed = false,
}: {
  id: string;
  d: string;
  accent?: boolean;
  dashed?: boolean;
}) {
  return (
    <path
      d={d}
      fill="none"
      stroke={accent ? ACCENT : INK}
      strokeOpacity={accent ? 1 : 0.45}
      strokeWidth={accent ? 1.5 : 1}
      strokeDasharray={dashed ? "4 4" : undefined}
      markerEnd={`url(#${id})`}
    />
  );
}

/**
 * Arrowheads are per-figure because two SVGs on one page cannot share a marker
 * id without the second one silently borrowing the first one's colour.
 */
function Heads({ id }: { id: string }) {
  return (
    <defs>
      <marker
        id={`${id}-ink`}
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M0 0.8 L7 4 L0 7.2 z" fill={INK} fillOpacity="0.45" />
      </marker>
      <marker
        id={`${id}-accent`}
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M0 0.8 L7 4 L0 7.2 z" fill={ACCENT} />
      </marker>
    </defs>
  );
}

function Dot({
  cx,
  cy,
  fill,
  r = 3.5,
  pulse = false,
}: {
  cx: number;
  cy: number;
  fill: string;
  r?: number;
  pulse?: boolean;
}) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={fill}
      className={pulse ? "standfast-pulse" : undefined}
    />
  );
}

/** The frame every drawing sits in: cream panel, title, one sentence, phase. */
export function Figure({
  eyebrow,
  title,
  caption,
  phase,
  minWidth,
  children,
}: {
  eyebrow: string;
  title: string;
  caption: ReactNode;
  phase: string;
  minWidth: number;
  children: ReactNode;
}) {
  return (
    <figure className="rounded-lg border border-line bg-neutral p-lg pb-[28px]">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <div>
          <p className="text-label-sm uppercase text-muted">{eyebrow}</p>
          <h3 className="mt-xs text-h3 text-balance text-primary">{title}</h3>
        </div>
        <Badge>{phase}</Badge>
      </div>

      <div className="mt-md overflow-x-auto">
        <div style={{ minWidth }}>{children}</div>
      </div>

      <figcaption className="mt-md max-w-[76ch] text-body-sm text-muted">
        {caption}
      </figcaption>
    </figure>
  );
}

/* ── 1. Write path ─────────────────────────────────────────────────────── */

const SECTIONS = [
  { name: "§ Scope", hash: "7c1e4b", live: false },
  { name: "§ Tenancy", hash: "a3f1c2", live: true },
  { name: "§ Queue", hash: "0d9a55", live: false },
  { name: "§ Egress", hash: "b62f18", live: false },
];

export function QuoteCheckFigure() {
  const id = "fig-quote";
  return (
    <svg
      viewBox="0 0 880 296"
      className="h-auto w-full"
      role="img"
      aria-labelledby={`${id}-t`}
    >
      <title id={`${id}-t`}>
        A document section extracted into a candidate atom, which is stored only
        when its quote matches the source verbatim
      </title>
      <Heads id={id} />

      {/* Document */}
      <Kicker x={0} y={16}>
        Versioned prose
      </Kicker>
      <Box x={0} y={30} w={244} h={216} r={12} />
      <T x={16} y={54} size={10} mono fill={INK}>
        docs/03-architecture.md
      </T>
      <line x1={16} y1={70} x2={228} y2={70} stroke={LINE} strokeWidth={1} />

      {SECTIONS.map((s, i) => {
        const y = 96 + i * 36;
        return (
          <g key={s.name}>
            {s.live ? (
              <rect
                x={8}
                y={y - 15}
                width={228}
                height={30}
                rx={8}
                fill={ACCENT}
                fillOpacity={0.08}
                stroke={ACCENT}
                strokeWidth={1.5}
              />
            ) : null}
            <T
              x={20}
              y={y}
              size={11}
              fill={s.live ? INK : MUTED}
              weight={s.live ? 500 : 400}
            >
              {s.name}
            </T>
            <rect
              x={150}
              y={y - 9}
              width={74}
              height={18}
              rx={9}
              fill="none"
              stroke={LINE}
            />
            <T x={187} y={y + 0.5} size={9} mono fill={MUTED} anchor="middle">
              {s.hash}
            </T>
          </g>
        );
      })}

      {/* extract */}
      <Kicker x={296} y={116} anchor="middle">
        extract
      </Kicker>
      <Arrow id={`${id}-ink`} d="M244 132 H 348" />

      {/* Candidate atom */}
      <Kicker x={364} y={16}>
        Candidate atom
      </Kicker>
      <Box x={364} y={30} w={230} h={216} r={12} />
      <T x={382} y={54} size={26} fill={ACCENT} weight={600}>
        &ldquo;
      </T>
      <T x={382} y={92} size={11} fill={INK}>
        Row-level security is
      </T>
      <T x={382} y={110} size={11} fill={INK}>
        written in the first
      </T>
      <T x={382} y={128} size={11} fill={INK}>
        migration, not later.
      </T>
      <line x1={382} y1={156} x2={576} y2={156} stroke={LINE} strokeWidth={1} />
      <T x={382} y={176} size={9} mono fill={MUTED}>
        section a3f1c2
      </T>
      <T x={382} y={196} size={9} mono fill={MUTED}>
        span 412–478
      </T>
      <T x={382} y={222} size={9} mono fill={MUTED}>
        code points, not bytes
      </T>

      {/* compare */}
      <Kicker x={640} y={116} anchor="middle">
        compare
      </Kicker>
      <Arrow id={`${id}-ink`} d="M594 132 H 660" />
      <path
        d="M660 132 H 676 V 88 H 700"
        fill="none"
        stroke={SUCCESS}
        strokeOpacity={0.8}
        strokeWidth={1.5}
        markerEnd={`url(#${id}-ink)`}
      />
      <Arrow id={`${id}-ink`} d="M660 132 H 676 V 190 H 700" dashed />

      {/* Outcomes */}
      <Box x={700} y={60} w={180} h={56} r={10} />
      <Dot cx={720} cy={80} fill={SUCCESS} />
      <T x={734} y={80} size={11} fill={INK} weight={500}>
        stored
      </T>
      <T x={720} y={100} size={9} mono fill={MUTED}>
        state: provisional
      </T>

      <Box x={700} y={162} w={180} h={56} r={10} dashed fill="none" />
      <path
        d="M716 178 l8 8 M724 178 l-8 8"
        stroke={MUTED}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <T x={734} y={182} size={11} fill={MUTED} weight={500}>
        refused
      </T>
      <T x={716} y={202} size={9} mono fill={MUTED}>
        quote ≠ source
      </T>

      {/* Ledger strip. The delta is the point: an unchanged project enqueues nothing. */}
      <line x1={0} y1={258} x2={880} y2={258} stroke={LINE} strokeWidth={1} />
      <T x={0} y={278} size={10} fill={MUTED}>
        sections are hashed — an edit re-extracts only what moved
      </T>
      <T x={862} y={278} size={9} mono fill={MUTED} anchor="end" tracking={1.2}>
        41 SECTIONS · 335 ATOMS ·{" "}
        <tspan fill={ACCENT} fontWeight={500}>
          Δ 1
        </tspan>
      </T>
      <Dot cx={874} cy={278} r={3} fill={ACCENT} pulse />
    </svg>
  );
}

/* ── 2. Read path ──────────────────────────────────────────────────────── */

const TREE = [
  { label: "packages/", indent: 0, open: false },
  { label: "db/", indent: 1, open: false },
  { label: "migrations/0001.sql", indent: 2, open: true },
  { label: "api/", indent: 1, open: false },
  { label: "routes/atoms.ts", indent: 2, open: false },
  { label: "docs/", indent: 0, open: false },
  { label: "03-architecture.md", indent: 1, open: false },
];

/** Elbows, placed by hand: the tree is fixed, so deriving them costs more than it saves. */
const SPINES = [
  { x: 24, y1: 66, y2: 139 },
  { x: 40, y1: 93, y2: 112 },
  { x: 40, y1: 147, y2: 166 },
  { x: 24, y1: 201, y2: 220 },
];
const STUBS = [
  { y: 85, x1: 24, x2: 32 },
  { y: 112, x1: 40, x2: 48 },
  { y: 139, x1: 24, x2: 32 },
  { y: 166, x1: 40, x2: 48 },
  { y: 220, x1: 24, x2: 32 },
];

/** Four of thirty-five are lit. The ratio is the argument. */
const GOVERNING = new Set([2, 13, 21, 30]);

const PACK = [
  {
    claim: "Row-level security lands in migration 0001",
    cite: "03-architecture.md:84",
    kind: "decision",
  },
  {
    claim: "Every migration has a hand-written reverse",
    cite: "04-data-model.md:210",
    kind: "convention",
  },
  {
    claim: "The API refuses a BYPASSRLS connection",
    cite: "13-threat-model.md:132",
    kind: "constraint",
  },
  {
    claim: "Tenant isolation is tested by crossing it",
    cite: "12-evaluation.md:56",
    kind: "convention",
  },
];

export function ContextScopeFigure() {
  const id = "fig-scope";
  const cols = 7;
  const pillW = 32;
  const pillH = 14;
  const gapX = 6;
  const gapY = 10;
  const gridX = 300;
  const gridY = 74;

  const cell = (i: number) => ({
    x: gridX + (i % cols) * (pillW + gapX),
    y: gridY + Math.floor(i / cols) * (pillH + gapY),
  });

  return (
    <svg
      viewBox="0 0 880 322"
      className="h-auto w-full"
      role="img"
      aria-labelledby={`${id}-t`}
    >
      <title id={`${id}-t`}>
        One open file, the four atoms out of hundreds that govern it, and the
        context pack assembled from them under a token budget
      </title>
      <Heads id={id} />

      {/* Repository */}
      <Kicker x={0} y={16}>
        Your repository
      </Kicker>
      <Box x={0} y={30} w={236} h={222} r={12} />
      {SPINES.map((s) => (
        <line
          key={`spine-${s.x}-${s.y1}`}
          x1={s.x}
          y1={s.y1}
          x2={s.x}
          y2={s.y2}
          stroke={INK}
          strokeOpacity={0.2}
          strokeWidth={1}
        />
      ))}
      {STUBS.map((s) => (
        <line
          key={`stub-${s.y}`}
          x1={s.x1}
          y1={s.y}
          x2={s.x2}
          y2={s.y}
          stroke={INK}
          strokeOpacity={0.2}
          strokeWidth={1}
        />
      ))}
      {TREE.map((row, i) => {
        const y = 58 + i * 27;
        return (
          <g key={row.label}>
            {row.open ? (
              <rect
                x={8}
                y={y - 13}
                width={220}
                height={26}
                rx={7}
                fill={ACCENT}
                fillOpacity={0.08}
                stroke={ACCENT}
                strokeWidth={1.5}
              />
            ) : null}
            <T
              x={20 + row.indent * 16}
              y={y}
              size={10}
              mono
              fill={row.open ? INK : MUTED}
              weight={row.open ? 500 : 400}
            >
              {row.label}
            </T>
          </g>
        );
      })}
      <T x={0} y={272} size={10} fill={MUTED}>
        the file in front of the agent
      </T>

      {/* Atom universe */}
      <Kicker x={300} y={16}>
        335 atoms in this project
      </Kicker>
      {Array.from({ length: 35 }, (_, i) => {
        const { x, y } = cell(i);
        const lit = GOVERNING.has(i);
        return (
          <rect
            key={`pill-${x}-${y}`}
            x={x}
            y={y}
            width={pillW}
            height={pillH}
            rx={7}
            fill={lit ? ACCENT : "none"}
            fillOpacity={lit ? 0.12 : 1}
            stroke={lit ? ACCENT : INK}
            strokeOpacity={lit ? 1 : 0.22}
            strokeWidth={lit ? 1.5 : 1}
          />
        );
      })}
      {[...GOVERNING].map((i) => {
        const { x, y } = cell(i);
        return (
          <path
            key={`link-${i}`}
            d={`M236 132 C 268 132, 268 ${y + pillH / 2}, ${x} ${y + pillH / 2}`}
            fill="none"
            stroke={ACCENT}
            strokeOpacity={0.55}
            strokeWidth={1}
          />
        );
      })}
      <T x={300} y={220} size={10} fill={INK}>
        <tspan fill={ACCENT} fontWeight={500}>
          4 govern this path
        </tspan>
        <tspan fill={MUTED}> · 331 are not sent</tspan>
      </T>
      <T x={300} y={242} size={10} fill={MUTED}>
        no generative call between the question and this answer
      </T>

      {/* assemble */}
      <Kicker x={598} y={116} anchor="middle">
        assemble
      </Kicker>
      <Arrow id={`${id}-accent`} d="M572 132 H 624" accent />

      {/* Context pack */}
      <Kicker x={632} y={16}>
        Context pack
      </Kicker>
      <Box x={632} y={30} w={248} h={222} r={12} />
      {PACK.map((row, i) => {
        const y = 62 + i * 42;
        return (
          <g key={row.cite}>
            <Dot cx={650} cy={y} fill={ACCENT} />
            <T x={664} y={y} size={9} fill={INK}>
              {row.claim}
            </T>
            <T x={664} y={y + 15} size={8.5} mono fill={MUTED}>
              {row.cite}
            </T>
            <Pill x={786} y={y + 15} w={76} label={row.kind} />
          </g>
        );
      })}
      <rect
        x={650}
        y={228}
        width={212}
        height={7}
        rx={3.5}
        fill={INK}
        fillOpacity={0.14}
      />
      <rect x={650} y={228} width={195} height={7} rx={3.5} fill={ACCENT} />
      <T x={650} y={272} size={9} mono fill={MUTED}>
        1,840 / 2,000 tokens
      </T>
      <rect
        x={762}
        y={262}
        width={118}
        height={20}
        rx={10}
        fill="none"
        stroke={LINE}
      />
      <T x={821} y={272.5} size={8.5} mono fill={MUTED} anchor="middle">
        truncated: false
      </T>
      <T x={632} y={302} size={10} fill={MUTED}>
        the flag is set by whatever truncated, never inferred
      </T>
    </svg>
  );
}

/* ── 3. Verification ───────────────────────────────────────────────────── */

const WITHHELD = [
  "file contents",
  "the AST",
  "the call graph",
  "the file tree",
];

const VERDICTS = [
  {
    state: "honored",
    cite: "packages/db/migrations/0001.sql:14",
    tone: SUCCESS,
  },
  {
    state: "drifted",
    cite: "packages/api/src/routes/atoms.ts:88",
    tone: ACCENT,
  },
  { state: "unknown", cite: "packages/worker/src/main.ts:210", tone: MUTED },
];

export function WireFigure() {
  const id = "fig-wire";
  return (
    <svg
      viewBox="0 0 880 318"
      className="h-auto w-full"
      role="img"
      aria-labelledby={`${id}-t`}
    >
      <title id={`${id}-t`}>
        A dashed boundary with the repository and the agent session on the
        customer's side, atoms and verdicts on Standfast's side, and only a
        verdict and a path:line crossing between them
      </title>
      <Heads id={id} />

      {/* The wire */}
      <line
        x1={440}
        y1={8}
        x2={440}
        y2={310}
        stroke={INK}
        strokeOpacity={0.4}
        strokeWidth={1.5}
        strokeDasharray="5 5"
      />

      <Kicker x={0} y={16}>
        Your machine
      </Kicker>
      <Kicker x={880} y={16} anchor="end">
        Standfast
      </Kicker>

      {/* Left: what stays */}
      <Box x={0} y={32} w={180} h={48} r={10} />
      <T x={18} y={56} size={11} fill={INK} weight={500}>
        your repository
      </T>
      <Box x={214} y={32} w={186} h={48} r={10} />
      <T x={232} y={56} size={11} fill={INK} weight={500}>
        your agent session
      </T>
      <Arrow id={`${id}-ink`} d="M180 56 H 206" />

      <Box
        x={0}
        y={106}
        w={400}
        h={116}
        r={12}
        fill="none"
        dashed
        stroke={MUTED}
        strokeOpacity={0.5}
      />
      <Kicker x={18} y={128}>
        Never leaves this side
      </Kicker>
      {WITHHELD.map((label, i) => {
        const x = 18 + (i % 2) * 188;
        const y = 152 + Math.floor(i / 2) * 38;
        return (
          <g key={label}>
            <rect
              x={x}
              y={y}
              width={176}
              height={28}
              rx={8}
              fill="none"
              stroke={INK}
              strokeOpacity={0.18}
            />
            <T x={x + 14} y={y + 14} size={10} fill={MUTED}>
              {label}
            </T>
          </g>
        );
      })}
      <path
        d="M400 164 H 424"
        stroke={MUTED}
        strokeWidth={1}
        strokeDasharray="3 3"
        fill="none"
      />
      <circle
        cx={432}
        cy={164}
        r={7}
        fill={SURFACE}
        stroke={MUTED}
        strokeWidth={1.2}
      />
      <path
        d="M428 168 l8 -8"
        stroke={MUTED}
        strokeWidth={1.2}
        strokeLinecap="round"
      />

      {/* Right: what Standfast holds */}
      <Box x={480} y={32} w={180} h={48} r={10} />
      <T x={498} y={56} size={11} fill={INK} weight={500}>
        ratified atoms
      </T>
      <Box x={694} y={32} w={186} h={48} r={10} />
      <T x={712} y={56} size={11} fill={INK} weight={500}>
        the verdict ledger
      </T>
      <Arrow id={`${id}-ink`} d="M660 56 H 686" />

      <Box x={480} y={106} w={400} h={116} r={12} fill="none" />
      <Kicker x={498} y={128}>
        The whole of what it stores
      </Kicker>
      {VERDICTS.map((v, i) => {
        const y = 156 + i * 26;
        return (
          <g key={v.cite}>
            <Dot cx={504} cy={y} fill={v.tone} />
            <T x={518} y={y} size={9.5} fill={INK} weight={500}>
              {v.state}
            </T>
            <T x={574} y={y} size={9} mono fill={MUTED}>
              {v.cite}
            </T>
          </g>
        );
      })}

      {/* What crosses */}
      <Arrow id={`${id}-accent`} d="M300 258 H 620" accent />
      <rect
        x={352}
        y={246}
        width={176}
        height={24}
        rx={12}
        fill={SURFACE}
        stroke={ACCENT}
        strokeWidth={1.5}
      />
      <T x={440} y={258.5} size={10} fill={ACCENT} weight={500} anchor="middle">
        verdict + path:line
      </T>

      <Arrow id={`${id}-ink`} d="M620 296 H 300" />
      <rect
        x={334}
        y={284}
        width={212}
        height={24}
        rx={12}
        fill={SURFACE}
        stroke={LINE}
      />
      <T x={440} y={296.5} size={10} fill={INK} anchor="middle">
        the atoms that govern this path
      </T>
    </svg>
  );
}

/**
 * Output goes through here so `--json` is honoured everywhere rather than in
 * whichever commands remembered.
 *
 * Data goes to stdout, everything else to stderr. That is what makes
 * `standfast project ls --json | jq` work: a progress line or a warning mixed
 * into stdout would corrupt the parse.
 */

export type Format = "text" | "json";

export class UsageError extends Error {}

export function out(format: Format, text: string, data: unknown): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function table(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          cell.padEnd(i === row.length - 1 ? 0 : (widths[i] ?? 0)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function heading(text: string): void {
  line();
  line(text);
  line("─".repeat(Math.min(text.length, 78)));
}

/**
 * Skips are printed, not swallowed. `docs/12-evaluation.md` says loudly, and
 * loudly is the operative word: a metric that did not run must never look like
 * a metric that passed.
 */
export function skipped(name: string, reason: string): void {
  line(`SKIPPED  ${name} — ${reason}`);
}

export function failure(message: string): void {
  process.stderr.write(`ERROR    ${message}\n`);
}

export function warning(message: string): void {
  process.stderr.write(`WARNING  ${message}\n`);
}

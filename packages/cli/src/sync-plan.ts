import { createHash } from "node:crypto";

/**
 * The pure half of `standfast sync`: `docs/10-sync-daemon.md`'s
 * `plan(scope, localState, remoteState) → operations`, row for row.
 *
 * No filesystem, no network, no clock — the only import is `node:crypto`,
 * which is deterministic. Everything here is decidable from the arguments,
 * which is what lets every row of the conflict table be a unit test, and what
 * lets a git hook, a CI step or a future watcher all call the same function.
 */

/** What this sync root governs, plus the journal's record of the last sync. */
export type Scope = {
  /** Matched paths that exist locally: repository-relative, forward slashes. */
  paths: string[];
  /**
   * Per path, the server's `contentHash` after the last successful sync — the
   * base. A hash, never a copy of the body: the folder holds the body.
   */
  base: Record<string, string>;
};

export type Operation =
  /** In sync: local, base and server all agree. */
  | { op: "noop"; path: string }
  /** Local is new or changed and the server has not moved since base: upload. */
  | { op: "push"; path: string }
  /**
   * The server moved and the folder did not: the remote hash becomes the new
   * base (`null` when the server no longer has the document) and nothing is
   * uploaded — sync never writes to the folder.
   */
  | { op: "rebase"; path: string; hash: string | null }
  /** Both sides moved since base: write nothing anywhere; a human resolves it. */
  | { op: "conflict"; path: string }
  /**
   * The file is gone locally but the server still holds the document. Absence
   * never deletes — a branch switch, a dropped mount or a mid-build scan all
   * look exactly like this — so it is reported, and `standfast doc rm` is the
   * only path that removes a document.
   */
  | { op: "unseen"; path: string };

/**
 * The conflict table of `docs/10-sync-daemon.md`, applied per path.
 *
 * `local` maps each matched path to its content hash; `remote` maps server
 * paths to their `contentHash`. The paths considered are the matched set plus
 * whatever the journal tracks — a remote document outside both belongs to
 * another clone or another writer and is neither touched nor reported.
 */
export function plan(
  scope: Scope,
  local: Record<string, string>,
  remote: Record<string, string>,
): Operation[] {
  const paths = [
    ...new Set([...scope.paths, ...Object.keys(scope.base)]),
  ].sort();
  const operations: Operation[] = [];

  for (const path of paths) {
    const l = local[path];
    const b = scope.base[path];
    const r = remote[path];

    if (l === undefined) {
      // absent | any → report, never delete. When the server does not hold it
      // either there is nothing to warn about, and the base entry lapses.
      if (r !== undefined) {
        operations.push({ op: "unseen", path });
      }
    } else if (l === r) {
      // Both sides hold the same bytes; at most the base needs to record it.
      operations.push(
        b === r ? { op: "noop", path } : { op: "rebase", path, hash: r },
      );
    } else if (b === undefined) {
      // No base. Local new when the server has nothing; otherwise two bodies
      // with no common ancestor, which only a human can order.
      operations.push(
        r === undefined ? { op: "push", path } : { op: "conflict", path },
      );
    } else if (r !== b) {
      // The server moved since base — to new content, or to absence.
      operations.push(
        l === b
          ? { op: "rebase", path, hash: r ?? null }
          : { op: "conflict", path },
      );
    } else {
      // changed | unchanged → upload, re-base.
      operations.push({ op: "push", path });
    }
  }

  return operations;
}

/**
 * Identity of a confirmed scope: sha256 hex of the sorted resolved path list.
 * Consent is recorded against what the globs actually matched, so widening a
 * glob — or a new file arriving under one — re-arms the plan rather than
 * inheriting yesterday's confirmation.
 */
export function scopeDigest(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(`${path}\n`, "utf8");
  }
  return hash.digest("hex");
}

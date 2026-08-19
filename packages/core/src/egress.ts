/**
 * The outbound counterpart to `wire-allowlist.ts`.
 *
 * `docs/13-threat-model.md` (*Egress*) states four rules. This module is rule
 * 1 — **named endpoints only**: every outbound destination is a configured
 * entry with a pinned model version, a provider not on the list is not called,
 * and the failure is a start-up refusal rather than a fallback.
 *
 * It lives in `core` because it is pure policy and because two processes need
 * the same answer: the worker, whose three phase-1 flows are the first outbound
 * calls this repository makes, and the API, whose phase-2 reranker is the
 * fourth and by far the most sensitive. A policy each of them implemented
 * separately is a policy that disagrees with itself.
 */

/** What an outbound call is for. Purpose, never destination — the destination is configuration. */
export const EGRESS_PURPOSES = [
  "extraction",
  "embedding",
  "judge",
  "query-embedding",
  "reranking",
] as const;

export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

/**
 * Purposes that may be configured today.
 *
 * `reranking` and `query-embedding` are deliberately absent, and refusing them
 * is rule 2 rather than tidiness. Rows one to three of the *Egress* table send
 * stored prose the customer uploaded, in a batch job, with no timing signal.
 * The read path sends a task description typed minutes ago, in real time — an
 * observer holding that stream learns what a team is building before the team
 * ships it. That is a second procurement decision and it needs its own consent,
 * so it cannot be switched on by adding a line to a phase-1 deployment's
 * configuration.
 *
 * **`query-embedding` is not `embedding`, and the distinction is the point.**
 * `embedding` is on this list because it embeds atoms: prose already stored,
 * in a queue worker, at a time unrelated to anyone's keystrokes. Reusing that
 * permission for the query would stretch a consent granted for a batch job to
 * cover the live stream it was explicitly distinguished from — and nothing
 * would fail, because the allowlist would admit it and the adapter would assert
 * successfully. It is a separate purpose so that the disclosure record can tell
 * a customer which of the two happened, and so that enabling one is not
 * silently enabling the other.
 *
 * ## What has to be true before `query-embedding` moves onto this list
 *
 * Not one thing, and privacy is only the first:
 *
 * 1. **Consent, recorded.** The decision rule 2 asks for, taken by a human and
 *    written down. `packages/api/src/adapters/query-embedder.ts` already
 *    refuses any destination that is not one the operator runs, so the
 *    consenting party is choosing between "our own model" and "nothing" rather
 *    than between providers — but somebody still has to choose.
 * 2. **A measured p95 for the call, inside `context`'s own.**
 *    `docs/06-retrieval.md` condition 4, "enforced by a test, not by
 *    intention". `context`'s p95 is itself unchosen and unchoosable until a
 *    corpus exists (`docs/14-roadmap.md`), so this one is not a formality —
 *    it is the condition that is furthest from being met, and it is unaffected
 *    by where the model runs.
 * 3. **A pinned version**, which the allowlist entry already carries.
 *
 * All five of `docs/06-retrieval.md`'s conditions are required together. An
 * adapter that satisfies four of them does not go on the read path, and the
 * existence of the adapter is not an argument that it should
 * (`docs/14-roadmap.md`: shipping code does not close a question about whether
 * to ship it).
 */
export const PERMITTED_PURPOSES: readonly EgressPurpose[] = [
  "extraction",
  "embedding",
  "judge",
];

export type EgressEntry = {
  readonly purpose: EgressPurpose;
  /** Scheme, host and port. Compared exactly; a path is not part of identity. */
  readonly origin: string;
  /** The pinned model version. Compared exactly. */
  readonly model: string;
};

export class EgressError extends Error {}

/** Hosts a plaintext call may reach: an operator running the model themselves. */
export function isLocal(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // A bare name with no dot is a container or service name on a private
  // network. Rule 4 is not satisfiable if `http://ollama:11434` is refused.
  return !hostname.includes(".");
}

/**
 * Reads the allowlist from its configured form.
 *
 * One entry per line or per `;`, three whitespace-separated fields:
 *
 *     extraction  https://api.example.com  some-model-2026-01-01
 *
 * Hand-parsed rather than JSON-in-an-environment-variable, because this is a
 * value an operator writes by hand and has to be able to read back. Blank lines
 * and `#` comments are allowed for the same reason.
 *
 * An empty or absent spec is an empty allowlist, which is not an error: it is
 * the correct configuration for a deployment that makes no outbound call, and
 * phase 1c is exactly that deployment.
 */
export function parseEgressAllowlist(spec: string | undefined): EgressEntry[] {
  if (!spec?.trim()) return [];

  const entries: EgressEntry[] = [];
  const lines = spec
    .split(/[;\n]/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 3) {
      throw new EgressError(
        `egress allowlist entry must be "purpose url model", got ${fields.length} field(s): ${line}`,
      );
    }
    const [rawPurpose, rawUrl, model] = fields as [string, string, string];

    if (!(EGRESS_PURPOSES as readonly string[]).includes(rawPurpose)) {
      throw new EgressError(
        `unknown egress purpose ${rawPurpose}. Known: ${EGRESS_PURPOSES.join(", ")}`,
      );
    }
    const purpose = rawPurpose as EgressPurpose;

    if (!PERMITTED_PURPOSES.includes(purpose)) {
      throw new EgressError(
        `egress purpose ${purpose} may not be configured yet (docs/13-threat-model.md, Egress, rule 2). The read path sends a developer's live task description rather than stored prose, and that is a separate procurement decision with its own consent.`,
      );
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new EgressError(`egress destination is not a URL: ${rawUrl}`);
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new EgressError(
        `egress destination must be http or https: ${rawUrl}`,
      );
    }
    if (url.protocol === "http:" && !isLocal(url.hostname)) {
      // Rule 4 needs plaintext to work against something the operator runs.
      // It does not need plaintext to the public internet.
      throw new EgressError(
        `egress destination ${rawUrl} is plaintext and not local. http is admitted only for a model the operator runs themselves.`,
      );
    }

    if (/(^|[-_/:])latest$/i.test(model)) {
      // Rule 1 says "a pinned model version". A floating alias is the one thing
      // that makes an allowlist entry stop describing what it admitted, without
      // the entry changing — and docs/02-principles.md (12) says never execute
      // the latest published version at every startup.
      throw new EgressError(
        `egress model ${model} is a floating alias. Rule 1 requires a pinned version.`,
      );
    }

    if (entries.some((e) => e.purpose === purpose)) {
      throw new EgressError(
        `egress purpose ${purpose} is configured twice. One destination per purpose, so "what left, to whom" has one answer.`,
      );
    }

    entries.push({ purpose, origin: url.origin, model });
  }

  return entries;
}

/**
 * Refuses unless the call is exactly what the allowlist admitted.
 *
 * Called at start-up and again inside each adapter's constructor, never on the
 * hot path. A check on the hot path fails once traffic is already flowing, and
 * by then the deployment is one someone relies on.
 */
export function assertEgressAllowed(
  allowlist: readonly EgressEntry[],
  purpose: EgressPurpose,
  destination: string,
  model: string,
): void {
  const entry = allowlist.find((e) => e.purpose === purpose);
  if (!entry) {
    throw new EgressError(
      `no egress allowlist entry for ${purpose}. A destination that is not on the list is not called (docs/13-threat-model.md, Egress, rule 1); add one to STANDFAST_EGRESS_ALLOWLIST.`,
    );
  }

  let origin: string;
  try {
    origin = new URL(destination).origin;
  } catch {
    throw new EgressError(`egress destination is not a URL: ${destination}`);
  }

  if (origin !== entry.origin) {
    throw new EgressError(
      `${purpose} is configured to call ${origin}, but the allowlist admits ${entry.origin}.`,
    );
  }
  if (model !== entry.model) {
    throw new EgressError(
      `${purpose} is configured for model ${model}, but the allowlist pins ${entry.model}.`,
    );
  }
}

/**
 * Asserts, then hands back the entry that admitted the call.
 *
 * This is the form an adapter uses. Constructing an adapter is the moment a
 * destination stops being configuration and becomes something a socket will be
 * opened to, so the check belongs there and not only in whatever wiring
 * happened to build it — `resolvePorts` checks, and so does every other caller
 * that ever constructs one, including a test.
 *
 * Returning the entry rather than void is what closes the gap the check would
 * otherwise leave: the adapter records what it was admitted for from the same
 * object that admitted it, so the row in `egress_events` cannot name one
 * destination while the request goes to another.
 */
export function admitEgress(
  allowlist: readonly EgressEntry[],
  purpose: EgressPurpose,
  destination: string,
  model: string,
): EgressEntry {
  assertEgressAllowed(allowlist, purpose, destination, model);
  const entry = allowlist.find((e) => e.purpose === purpose);
  if (!entry)
    throw new EgressError(`no egress allowlist entry for ${purpose}.`);
  return entry;
}

/**
 * What would leave this deployment, to whom, and as which model.
 *
 * Rule 3 says egress is disclosable: a customer can ask what left, and if the
 * answer requires reading code the answer is not good enough. This is the
 * static half of that answer — the destinations a deployment is configured to
 * reach. The per-project half, a record of what actually left and when, is the
 * `egress_events` table: this function says what a deployment *may* send, that
 * table says what it *did*, and rule 3 needs both. A configuration nobody
 * exercised and a call nobody configured are different problems.
 */
export function describeEgress(allowlist: readonly EgressEntry[]): string {
  if (allowlist.length === 0) {
    return "egress: nothing. No outbound destination is configured.";
  }
  return [
    "egress:",
    ...allowlist
      .slice()
      .sort((a, b) => a.purpose.localeCompare(b.purpose))
      .map((e) => `  ${e.purpose} -> ${e.origin} (${e.model})`),
  ].join("\n");
}

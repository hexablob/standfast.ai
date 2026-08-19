import { extractionPortIds, FAKE_PORT_IDS } from "@standfast/core";
/**
 * What a slice needs before it can honestly produce a number.
 *
 * A skipped metric that reports as a pass is the same class of failure as
 * `truncated` inferred from `returned < total`: a caller that believes it has
 * seen everything reasons confidently and wrongly. So an unmet precondition is
 * printed as SKIPPED with its reason, recorded in the summary, and never
 * folded into a pass.
 */
export type Precondition = {
  name: string;
  met: boolean;
  reason: string;
};

export function databaseAvailable(
  env: Record<string, string | undefined>,
): Precondition {
  const url = env["DATABASE_URL"];
  return url
    ? { name: "database", met: true, reason: "DATABASE_URL is set" }
    : {
        name: "database",
        met: false,
        reason:
          "DATABASE_URL is not set. Retrieval is a database query; without " +
          "one there is nothing to measure.",
      };
}

/**
 * Whether a real extractor is configured and reachable.
 *
 * This was a hardcoded `false` from phase 1b until now, and the comment there
 * predicted exactly this: "when the extractor arrives, this becomes the
 * credential check, and everything downstream of it already behaves correctly."
 * The extractor arrived in 1d. This is that check.
 *
 * Unmet is still the ordinary answer, and deliberately so. A deployment with no
 * provider configured runs on deterministic fakes — a bullet-splitter and a
 * bag-of-words embedder — and **a fake extractor is not an extractor**. Letting
 * the harness measure one would record a number against a bar that
 * `docs/12-evaluation.md` says is chosen from the first full run, once, after
 * which it may only tighten. A bar set against a bullet-splitter could then
 * only be defended or quietly forgotten.
 *
 * So the three port ids must all name providers, and the credentials must be
 * present. It deliberately does **not** check the egress allowlist: that is the
 * worker's start-up refusal to make, and duplicating it here would put a
 * security control in two places that can disagree.
 */
export function extractorAvailable(
  env: Record<string, string | undefined> = process.env,
): Precondition {
  const ports = extractionPortIds(env);
  const fakes = (
    [
      ["STANDFAST_EXTRACTION_MODEL", ports.extractionModel],
      ["STANDFAST_EMBEDDING_MODEL", ports.embeddingModel],
      ["STANDFAST_JUDGE_MODEL", ports.judgeModel],
    ] as const
  ).filter(([, id]) => FAKE_PORT_IDS.has(id));

  if (fakes.length > 0) {
    return {
      name: "extractor",
      met: false,
      reason:
        `deterministic fakes are configured for ${fakes.map(([name]) => name).join(", ")}. ` +
        "A fake extractor is not an extractor, and a bar set against one could " +
        "never be defended (docs/12-evaluation.md).",
    };
  }

  if (ports.promptVersion === "none") {
    return {
      name: "extractor",
      met: false,
      reason:
        "STANDFAST_EXTRACTION_PROMPT_VERSION is unset, so extractor_version would " +
        "name a prompt nobody can identify. A run that cannot say which prompt " +
        "produced it is not reproducible.",
    };
  }

  const missing = ["ANTHROPIC_API_KEY", "VOYAGE_API_KEY"].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    return {
      name: "extractor",
      met: false,
      reason: `${missing.join(" and ")} not set, so the configured providers cannot be reached.`,
    };
  }

  return {
    name: "extractor",
    met: true,
    reason: `${ports.extractionModel}, ${ports.embeddingModel}, ${ports.judgeModel} at prompt ${ports.promptVersion}`,
  };
}

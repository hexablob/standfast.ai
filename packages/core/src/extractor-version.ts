import { createHash } from "node:crypto";
import { DEDUP_BANDS } from "./similarity.js";

/**
 * The version of the Markdown sectioner in `markdown.ts`.
 *
 * Bump it when a change to `sectionMarkdown` would put different text in a
 * section. A section whose boundaries moved is a different extraction input
 * even when its hash happens to survive.
 */
export const SECTIONER_VERSION = "1";

/**
 * The version of the fixed processing order a full re-extraction uses:
 * documents by path, sections by ordinal, candidates by position in the section.
 *
 * docs/05-extraction.md makes this part of the extractor version rather than an
 * implementation detail, and the reason is dedup: first writer wins, so the same
 * documents processed in a different order yield a different — equally correct —
 * set of atoms. Fine for a running system, fatal for a harness, which would
 * measure the noise.
 */
export const ORDERING_VERSION = "1";

/**
 * Everything that changes what extraction produces.
 *
 * One opaque string rather than five columns, because any of them changing
 * invalidates exactly the same thing: `section_extractions` is unique on
 * `(section_id, extractor_version)`, so this value *is* the idempotency key.
 */
export type ExtractorVersionInputs = {
  /** Identifies the extraction prompt. */
  readonly promptVersion: string;
  /** The extraction model's port id, e.g. `fake-bullet-1`. */
  readonly extractionModel: string;
  /** The embedding model's port id. Present even while it is a fake. */
  readonly embeddingModel: string;
  /** The dedup judge's port id. */
  readonly judgeModel: string;
  /** Lower dedup band. Defaults to the settled value. */
  readonly judgeFrom?: number;
  /** Upper dedup band. Defaults to the settled value. */
  readonly duplicateFrom?: number;
  /** Defaults to {@link SECTIONER_VERSION}. */
  readonly sectionerVersion?: string;
  /** Defaults to {@link ORDERING_VERSION}. */
  readonly orderingVersion?: string;
};

/**
 * Derives the opaque extractor version.
 *
 * Deliberately over-inclusive. The two ways to get this wrong are not
 * symmetric: omit an input and the corpus goes **silently stale**, which no
 * number in the evaluation harness can see, because a section that was never
 * re-extracted looks exactly like a section the extractor had nothing new to
 * say about. Include something that churns and you get spurious re-extraction,
 * which is loud, immediate and merely expensive. Prefer the failure you will
 * notice.
 *
 * The embedding model is a component even though it does not change which
 * candidates the extractor proposes. It changes which of them survive dedup,
 * and re-embedding without re-deduplicating leaves a corpus inconsistent with
 * its own merge threshold with nothing to surface it.
 *
 * Components are joined length-prefixed rather than separated by a delimiter,
 * for the same collision reason `sectionHash` length-prefixes a heading path: a
 * model named `a-b` and a prompt named `c` must not hash the same as a model
 * `a` and a prompt `b-c`. Sorted by name, so the order of the fields above is
 * not load-bearing.
 */
export function extractorVersion(inputs: ExtractorVersionInputs): string {
  const components: Array<[string, string]> = [
    ["prompt", inputs.promptVersion],
    ["extract", inputs.extractionModel],
    ["embed", inputs.embeddingModel],
    ["judge", inputs.judgeModel],
    ["judgeFrom", String(inputs.judgeFrom ?? DEDUP_BANDS.judgeFrom)],
    [
      "duplicateFrom",
      String(inputs.duplicateFrom ?? DEDUP_BANDS.duplicateFrom),
    ],
    ["sectioner", inputs.sectionerVersion ?? SECTIONER_VERSION],
    ["ordering", inputs.orderingVersion ?? ORDERING_VERSION],
  ];
  components.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const hash = createHash("sha256");
  hash.update(`${components.length}\n`);
  for (const [name, value] of components) {
    hash.update(`${[...name].length}:${name}\n`);
    hash.update(`${[...value].length}:${value}\n`);
  }

  // Prefixed so the string is recognisable in a database row and in a job
  // payload, and so the scheme itself can change without the values colliding.
  return `ev1-${hash.digest("hex").slice(0, 16)}`;
}

/**
 * Which extractor, embedder and judge a deployment is configured to use.
 *
 * Here rather than in `@standfast/db` because three separate processes need the
 * same answer and none of them is the owner: the API stamps the derived version
 * into job payloads, the worker claims `section_extractions` with it, and the
 * evaluation harness has to decide whether a real extractor exists at all. The
 * harness deliberately does not depend on `db`, so a copy of these four names
 * would have been the alternative.
 *
 * The defaults name the deterministic fakes. They are not a fallback to
 * something real: `docs/05-extraction.md` requires that no default reaches the
 * network without being asked to, and a fake that cannot reach anything is the
 * strongest form of that.
 */
export function extractionPortIds(
  env: Record<string, string | undefined> = process.env,
): Pick<
  ExtractorVersionInputs,
  "promptVersion" | "extractionModel" | "embeddingModel" | "judgeModel"
> {
  return {
    promptVersion: env["STANDFAST_EXTRACTION_PROMPT_VERSION"] ?? "none",
    extractionModel: env["STANDFAST_EXTRACTION_MODEL"] ?? "fake-bullet-1",
    embeddingModel: env["STANDFAST_EMBEDDING_MODEL"] ?? "fake-bow-1",
    judgeModel: env["STANDFAST_JUDGE_MODEL"] ?? "fake-judge-1",
  };
}

/** Port ids that name a deterministic fake rather than a provider. */
export const FAKE_PORT_IDS: ReadonlySet<string> = new Set([
  "fake-bullet-1",
  "fake-bow-1",
  "fake-judge-1",
]);

/** The opaque version a deployment extracts at. */
export function currentExtractorVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  return extractorVersion(extractionPortIds(env));
}

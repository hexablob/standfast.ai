import { createHash } from "node:crypto";

/** SHA-256 hex of a document body. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Identity of a section, for incremental extraction.
 *
 * Content-based, not position-based: a section that moves within a document
 * without changing keeps its hash, so an edit re-extracts only what actually
 * changed. That is the whole point of storing it.
 *
 * The inputs are length-prefixed rather than joined by a separator. With a
 * separator, `["a", "b/c"]` and `["a/b", "c"]` collide for any separator a
 * heading could contain, and two different sections would then share an
 * identity — which would silently suppress re-extraction of one of them.
 */
export function sectionHash(
  headingPath: readonly string[],
  body: string,
): string {
  const hash = createHash("sha256");
  hash.update(`${headingPath.length}\n`, "utf8");
  for (const part of headingPath) {
    hash.update(`${[...part].length}:${part}\n`, "utf8");
  }
  hash.update(body, "utf8");
  return hash.digest("hex");
}

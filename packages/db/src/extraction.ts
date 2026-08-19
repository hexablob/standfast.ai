import { currentExtractorVersion } from "@standfast/core";
import { type EnqueueSectionExtract, enqueueSectionExtract } from "./queue.js";

/**
 * What a serving process hands to `putDocument`.
 *
 * A record rather than two arguments, so a caller cannot pass an enqueue from
 * one configuration and a version from another.
 */
export type ExtractionEnqueue = {
  readonly enqueue: EnqueueSectionExtract;
  readonly extractorVersion: string;
};

/** The real one: a transactional send at the configured version. */
export function liveExtraction(
  env: Record<string, string | undefined> = process.env,
): ExtractionEnqueue {
  return {
    enqueue: enqueueSectionExtract,
    extractorVersion: currentExtractorVersion(env),
  };
}

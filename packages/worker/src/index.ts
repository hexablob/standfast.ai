// @standfast/worker — pg-boss consumers for the extraction pipeline.
//
// The ports are the package's surface. The three things extraction cannot do
// for itself — propose candidates, embed them, adjudicate a near-duplicate —
// are interfaces here and adapters in phase 1d, which is what lets the whole
// pipeline be built and tested with no network and no secrets.
//
// The fakes are deliberately not exported. They are test material, and a fake
// extractor that anything outside this package can reach is a fake extractor
// that eventually ends up behind something real.

// The handler, so the evaluation harness can drive the pipeline directly rather
// than through the queue. A run that has to be reproducible cannot depend on
// the order however many workers happen to fetch jobs in.
export {
  DEFAULT_CANDIDATE_CAP,
  DEFAULT_LEASE_SECONDS,
  type HandlerConfig,
  type HandlerOutcome,
  makeSectionExtractHandler,
} from "./handler.js";
// The harness resolves the same ports the worker would, so a run is produced by
// the configuration a deployment actually has rather than by a second wiring.
export { resolvePorts } from "./main.js";
export {
  type AtomKind,
  type Candidate,
  type DedupJudge,
  EMBEDDING_DIMENSIONS,
  type Embedder,
  type Extractor,
  type Ports,
  type SectionInput,
  type Verdict,
} from "./ports.js";
export { projectSectionsInOrder, rebuildProject } from "./rebuild.js";

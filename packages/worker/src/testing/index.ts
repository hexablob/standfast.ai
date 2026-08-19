// Test-only exports, published under `@standfast/worker/testing`.
//
// A separate entrypoint because these are deterministic fakes. A fake extractor
// that `import "@standfast/worker"` can reach is a fake extractor that eventually
// ends up behind something real; reaching it has to be deliberate.
//
// The evaluation harness imports them to prove its own plumbing without a
// model. That is not a loophole: `extractorAvailable()` refuses to report any
// number produced this way.

export { type DrainResult, drain } from "../drain.js";
export {
  AbsentQuoteExtractor,
  BagOfWordsEmbedder,
  BulletExtractor,
  type FaultInjection,
  fakePorts,
  ScriptedJudge,
} from "../fakes.js";

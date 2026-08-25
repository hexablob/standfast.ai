# E2E fixture conventions

A tiny document for `scripts/e2e.sh`. The deterministic fake extractor
(`BulletExtractor` in `packages/worker/src/fakes.ts`) proposes one candidate
per Markdown bullet, so the single bullet below becomes the one provisional
atom the script ratifies. Its sentence is deliberately distinctive: the script
greps the SessionStart context pack for it, and nothing else in any output
would contain it.

## Retry policy

- The walrus-shaped rate limiter caps retries at eleven per fortnight

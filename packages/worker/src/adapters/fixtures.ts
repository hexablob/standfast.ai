/**
 * Response fixtures for the adapter contract tests.
 *
 * **Hand-authored from each provider's published response shape, not recorded
 * from a live call.** Nothing here has been through the network, and saying so
 * matters: a fabricated fixture presented as a recording is a test that proves
 * the code agrees with an assumption rather than with a provider.
 *
 * What they are good for is the half that a recording would not improve — that
 * this adapter reads the documented shape correctly, refuses a malformed one,
 * and never lets a wrong-width or permuted batch reach the pipeline. What they
 * cannot tell you is whether the shape is right. `pnpm --filter @standfast/worker
 * run record-fixtures` overwrites this file from one live call per provider;
 * until somebody runs it, treat the shapes as claims from documentation.
 */

/** Set by the recorder. Empty means nothing here came from a provider. */
export const RECORDED_AT: string | null = null;

/** Messages API, structured output, one section yielding two candidates. */
export const ANTHROPIC_EXTRACTION_RESPONSE = {
  id: "msg_01FixtureExtraction",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        candidates: [
          {
            statement: "Deploys happen on Fridays.",
            kind: "convention",
            quote: "Deploys happen on Fridays",
          },
          {
            statement: "Every migration must be reversible.",
            kind: "constraint",
            quote: "every migration must be reversible",
          },
        ],
      }),
    },
  ],
  stop_reason: "end_turn",
  stop_details: null,
  usage: { input_tokens: 512, output_tokens: 96 },
};

/** A section the model declined. A section-level outcome, not a crash. */
export const ANTHROPIC_REFUSAL_RESPONSE = {
  id: "msg_01FixtureRefusal",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [],
  stop_reason: "refusal",
  stop_details: { type: "refusal", category: "cyber", explanation: null },
  usage: { input_tokens: 512, output_tokens: 0 },
};

/** Structured output truncated mid-JSON. Parsing it would look complete. */
export const ANTHROPIC_TRUNCATED_RESPONSE = {
  id: "msg_01FixtureTruncated",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: '{"candidates":[{"statement":"Deploys' }],
  stop_reason: "max_tokens",
  stop_details: null,
  usage: { input_tokens: 512, output_tokens: 16 },
};

export const ANTHROPIC_JUDGE_RESPONSE = {
  id: "msg_01FixtureJudge",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        separating_situation:
          "A migration that is reversible but has no test would satisfy one and not the other.",
        verdict: "different-claim",
      }),
    },
  ],
  stop_reason: "end_turn",
  stop_details: null,
  usage: { input_tokens: 128, output_tokens: 48 },
};

/** A 1024-long vector, deterministic so the fixture stays small in the diff. */
export function fixtureVector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => ((seed + i) % 7) / 7);
}

/**
 * Voyage embeddings response.
 *
 * Deliberately out of order. The provider documents `index` on each item, and
 * a permuted batch attaches every embedding to the wrong statement — which
 * nothing downstream could detect, because every vector would still be valid.
 */
export const VOYAGE_EMBEDDINGS_RESPONSE = {
  object: "list",
  data: [
    { object: "embedding", index: 1, embedding: fixtureVector(2) },
    { object: "embedding", index: 0, embedding: fixtureVector(1) },
  ],
  model: "voyage-3",
  usage: { total_tokens: 24 },
};

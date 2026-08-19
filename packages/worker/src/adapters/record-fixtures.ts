/**
 * Overwrites `fixtures.ts` from one live call per provider.
 *
 *   ANTHROPIC_API_KEY=… VOYAGE_API_KEY=… pnpm --filter @standfast/worker run record-fixtures
 *
 * The fixtures in the repository today are hand-authored from published
 * response shapes and say so. They test that the adapters read the documented
 * shape correctly; they cannot test that the shape is right. This closes that
 * gap, once, and stamps `RECORDED_AT` so the difference is visible in the file
 * rather than remembered.
 *
 * Never run from CI. `docs/12-evaluation.md` keeps model-calling work off the
 * pull-request path — secrets are not available to a fork, and a test that
 * calls a provider is a test that fails when somebody else's service is down.
 * This is a developer running one command and committing the diff.
 *
 * It calls the providers directly rather than through the adapters, because the
 * adapters are what the fixtures exist to test. Recording through them would
 * bake this build's parsing into the evidence for that parsing.
 */

import { writeFileSync } from "node:fs";

const SECTION = [
  "# Conventions",
  "",
  "Deploys happen on Fridays, and every migration must be reversible.",
].join("\n");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set.`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const anthropicKey = required("ANTHROPIC_API_KEY");
  const voyageKey = required("VOYAGE_API_KEY");

  const anthropicBase =
    process.env["STANDFAST_RECORD_ANTHROPIC_URL"] ??
    "https://api.anthropic.com";
  const voyageBase =
    process.env["STANDFAST_RECORD_VOYAGE_URL"] ?? "https://api.voyageai.com";

  const { EXTRACTION_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT } = await import(
    "./prompts.js"
  );

  const anthropic = async (body: unknown): Promise<unknown> => {
    const response = await fetch(`${anthropicBase}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`anthropic ${response.status}: ${JSON.stringify(json)}`);
    }
    return json;
  };

  const CANDIDATE_SCHEMA = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            statement: { type: "string" },
            kind: {
              type: "string",
              enum: ["constraint", "decision", "convention"],
            },
            quote: { type: "string" },
          },
          required: ["statement", "kind", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  };

  console.error("recording extraction…");
  const extraction = await anthropic({
    model: "claude-opus-5",
    max_tokens: 16_000,
    system: EXTRACTION_SYSTEM_PROMPT,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: CANDIDATE_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Heading path: Conventions\n\nSection body:\n${SECTION}`,
      },
    ],
  });

  console.error("recording judge…");
  const judge = await anthropic({
    model: "claude-sonnet-5",
    max_tokens: 4_000,
    system: JUDGE_SYSTEM_PROMPT,
    output_config: {
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            separating_situation: { type: "string" },
            verdict: {
              type: "string",
              enum: ["same-claim", "different-claim"],
            },
          },
          required: ["separating_situation", "verdict"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content:
          "Existing statement:\nEvery migration is tested.\n\nCandidate statement:\nEvery migration must be reversible.",
      },
    ],
  });

  console.error("recording embeddings…");
  const embeddingResponse = await fetch(`${voyageBase}/v1/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${voyageKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: ["Deploys happen on Fridays.", "Every migration is reversible."],
      model: "voyage-3",
      input_type: "document",
    }),
  });
  const embeddings = await embeddingResponse.json();
  if (!embeddingResponse.ok) {
    throw new Error(
      `voyage ${embeddingResponse.status}: ${JSON.stringify(embeddings)}`,
    );
  }

  const stamp = new Date().toISOString();
  const out = `/**
 * Response fixtures for the adapter contract tests.
 *
 * **Recorded from live calls** by \`pnpm --filter @standfast/worker run
 * record-fixtures\`. Do not hand-edit: the point of this file is that it is
 * evidence rather than an assumption, and an edited recording is neither.
 * Re-record instead, and commit the diff.
 */

/** When these were recorded. Null would mean nothing here came from a provider. */
export const RECORDED_AT: string | null = ${JSON.stringify(stamp)};

export const ANTHROPIC_EXTRACTION_RESPONSE = ${JSON.stringify(extraction, null, 2)};

export const ANTHROPIC_JUDGE_RESPONSE = ${JSON.stringify(judge, null, 2)};

export const VOYAGE_EMBEDDINGS_RESPONSE = ${JSON.stringify(embeddings, null, 2)};

/**
 * The two failure shapes below stay hand-authored.
 *
 * A refusal and a truncation cannot be recorded on demand without sending a
 * request designed to be declined or starved, which is a worse thing to have in
 * the repository than a hand-written object. They are documented shapes, and
 * the tests that use them say so.
 */
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

/** Kept so the width assertions have something to build from. */
export function fixtureVector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => ((seed + i) % 7) / 7);
}
`;

  const target = new URL("./fixtures.ts", import.meta.url).pathname.replace(
    "/dist/",
    "/src/",
  );
  writeFileSync(target, out);
  console.error(`wrote ${target} (recorded ${stamp})`);
  console.error(
    "Review the diff before committing: these responses are model output.",
  );
}

if (process.argv[1]?.endsWith("record-fixtures.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

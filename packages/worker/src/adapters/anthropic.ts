import Anthropic from "@anthropic-ai/sdk";
import { admitEgress, type EgressEntry } from "@standfast/core";
import type {
  AtomKind,
  Candidate,
  DedupJudge,
  Extractor,
  SectionInput,
  Verdict,
} from "../ports.js";
import { EXTRACTION_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT } from "./prompts.js";

/**
 * The extractor and the dedup judge, over the Messages API.
 *
 * Both are in one file because they share the client, the refusal handling and
 * the two request-shaping decisions below, and separating them would duplicate
 * all three.
 */

/** Raised when the model declined. A section-level outcome, not a crash. */
export class RefusedError extends Error {
  constructor(readonly category: string | null) {
    super(`the model declined this section (${category ?? "no category"})`);
    this.name = "RefusedError";
  }
}

export type AnthropicOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  /**
   * The allowlist this adapter must be admitted by.
   *
   * Required, and carried on the options rather than checked by whoever builds
   * the adapter, because an adapter that can be constructed without one is an
   * adapter a second wiring — a test, the evaluation harness, a future
   * process — can point anywhere. docs/13-threat-model.md (*Egress*, rule 1).
   */
  readonly allowlist: readonly EgressEntry[];
  readonly maxTokens?: number;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Injected in tests so the request shape can be asserted without a network. */
  readonly fetch?: typeof fetch;
};

function clientFor(options: AnthropicOptions): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    // Always explicit. The SDK would otherwise resolve a key or an OAuth
    // profile from the environment, and a worker that silently picks up
    // whatever credential the host happens to carry is a worker whose egress
    // destination is not the one the allowlist admitted.
    baseURL: options.baseURL,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/**
 * Neither request below sets `fallbacks`, and that is a decision rather than an
 * omission.
 *
 * The Anthropic SDK recommends server-side refusal fallbacks by default: a
 * declined request is re-run on another model and that model's answer is
 * returned. For most callers it is strictly better than a refusal. Here it
 * would make `atoms.extractor_version` false — the version pins which model
 * produced a statement, and a silent substitution would attribute one model's
 * output to another with nothing in the row to say so. Re-projection reads that
 * column to decide what is stale, so a wrong value is not cosmetic.
 *
 * A refusal is surfaced instead as a failed extraction for that section, with
 * the category, and left for a human. That is also the honest answer for a
 * system whose premise is that provenance is checkable.
 */

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
} as const;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    separating_situation: {
      type: "string",
      description:
        "A situation in which the two statements rule differently, or an empty string if none was found.",
    },
    verdict: { type: "string", enum: ["same-claim", "different-claim"] },
  },
  required: ["separating_situation", "verdict"],
  additionalProperties: false,
} as const;

/** Reads the one text block, refusing to guess when the model declined. */
function textOf(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") {
    throw new RefusedError(message.stop_details?.category ?? null);
  }
  if (message.stop_reason === "max_tokens") {
    // Structured output truncated mid-JSON. Parsing it would produce a partial
    // candidate list that looks complete.
    throw new Error("response hit max_tokens; output is truncated");
  }
  const text = message.content.find((b) => b.type === "text");
  if (text?.type !== "text") {
    throw new Error(`no text block in response (stop: ${message.stop_reason})`);
  }
  return text.text;
}

export class AnthropicExtractor implements Extractor {
  readonly id: string;
  readonly egress: EgressEntry;
  // The window this adapter accepts, well inside the model's context. A
  // section larger than this is a document-structure problem and is reported
  // as one rather than silently truncated.
  readonly maxInputChars = 200_000;

  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    // Before the client exists. `clientFor` opens nothing on its own, but the
    // ordering is the claim: there is no arrangement of these two lines in
    // which an unadmitted destination gets as far as a constructed client.
    this.egress = admitEgress(
      options.allowlist,
      "extraction",
      options.baseURL,
      options.model,
    );
    this.id = options.model;
    this.client = clientFor(options);
  }

  async extract(
    section: SectionInput,
    signal: AbortSignal,
  ): Promise<readonly Candidate[]> {
    if (section.body.length > this.maxInputChars) {
      throw new Error(
        `section is ${section.body.length} characters, above this extractor's ${this.maxInputChars}`,
      );
    }

    const heading =
      section.headingPath.length > 0
        ? section.headingPath.join(" > ")
        : "(no heading)";

    const message = await this.client.messages.create(
      {
        model: this.options.model,
        max_tokens: this.options.maxTokens ?? 16_000,
        system: EXTRACTION_SYSTEM_PROMPT,
        // No temperature, top_p or top_k: removed on this model family, and
        // determinism was never what they bought.
        output_config: {
          effort: this.options.effort ?? "high",
          format: { type: "json_schema", schema: CANDIDATE_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: `Heading path: ${heading}\n\nSection body:\n${section.body}`,
          },
        ],
      },
      { signal },
    );

    const parsed = JSON.parse(textOf(message)) as {
      candidates: Array<{ statement: string; kind: string; quote: string }>;
    };

    // Returned in the order the model listed them, which the pipeline treats as
    // position within the section — part of the extractor version.
    return parsed.candidates.map((c) => ({
      statement: c.statement,
      kind: c.kind as AtomKind,
      quote: c.quote,
    }));
  }
}

export class AnthropicJudge implements DedupJudge {
  readonly id: string;
  readonly egress: EgressEntry;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    // `judge`, not `extraction`. The two are separate allowlist entries even
    // when they name the same origin, so a deployment can pin them to
    // different model versions and a disclosure can say which one was asked.
    this.egress = admitEgress(
      options.allowlist,
      "judge",
      options.baseURL,
      options.model,
    );
    this.id = options.model;
    this.client = clientFor(options);
  }

  async adjudicate(
    pair: { readonly candidate: string; readonly incumbent: string },
    signal: AbortSignal,
  ): Promise<Verdict> {
    const message = await this.client.messages.create(
      {
        model: this.options.model,
        max_tokens: this.options.maxTokens ?? 4_000,
        system: JUDGE_SYSTEM_PROMPT,
        output_config: {
          effort: this.options.effort ?? "medium",
          format: { type: "json_schema", schema: VERDICT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: `Existing statement:\n${pair.incumbent}\n\nCandidate statement:\n${pair.candidate}`,
          },
        ],
      },
      { signal },
    );

    const parsed = JSON.parse(textOf(message)) as { verdict: string };
    if (
      parsed.verdict !== "same-claim" &&
      parsed.verdict !== "different-claim"
    ) {
      throw new Error(`judge returned an unknown verdict: ${parsed.verdict}`);
    }
    return parsed.verdict;
  }
}

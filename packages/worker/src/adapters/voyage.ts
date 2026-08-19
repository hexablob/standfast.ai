import { admitEgress, type EgressEntry } from "@standfast/core";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../ports.js";

/**
 * The embedder, over Voyage AI's embeddings endpoint.
 *
 * Raw `fetch` rather than an SDK, and that is not the usual "one fewer
 * dependency" argument: Voyage publishes no official TypeScript client, so the
 * alternative is a third-party wrapper around one POST. `CLAUDE.md` asks for a
 * dependency to be justified, and this one could not be.
 *
 * voyage-3 returns 1024 dimensions natively, which is what `atoms.embedding`
 * is — no truncation, and no Matryoshka assumption to be wrong about later.
 */

export type VoyageOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  /** The allowlist this adapter must be admitted by. See `AnthropicOptions`. */
  readonly allowlist: readonly EgressEntry[];
  /** Retries on 429 and 5xx. Anything else fails immediately. */
  readonly maxRetries?: number;
};

type VoyageResponse = {
  data?: Array<{ embedding: number[]; index: number }>;
  detail?: string;
};

export class VoyageEmbedder implements Embedder {
  readonly id: string;
  readonly egress: EgressEntry;

  /**
   * voyage-3 accepts 32,000 tokens. Held at a conservative character budget
   * because this port declares characters, and the ratio is content-dependent.
   *
   * The number matters less than it usually would: it is far above any window
   * the extractor will produce, so the embedder is not what constrains how a
   * long section gets split. That was the deciding argument for this provider.
   */
  readonly maxInputChars = 80_000;

  constructor(private readonly options: VoyageOptions) {
    this.egress = admitEgress(
      options.allowlist,
      "embedding",
      options.baseURL,
      options.model,
    );
    this.id = options.model;
  }

  async embed(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];

    for (const text of texts) {
      if (text.length > this.maxInputChars) {
        throw new Error(
          `input is ${text.length} characters, above this embedder's ${this.maxInputChars}`,
        );
      }
    }

    const body = JSON.stringify({
      input: texts,
      model: this.options.model,
      // These are atom statements being stored and compared against each
      // other, not queries against a corpus. Voyage embeds the two
      // asymmetrically, and using the query side here would place stored atoms
      // in a different part of the space from every atom already stored.
      input_type: "document",
    });

    const maxRetries = this.options.maxRetries ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await fetch(`${this.options.baseURL}/v1/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal,
        });

        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(
            `voyage responded ${response.status}: ${await response.text()}`,
          );
          if (attempt < maxRetries) {
            await delay(2 ** attempt * 500, signal);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          // 4xx other than 429: a bad key, a bad model name, an input over the
          // limit. Retrying cannot help and would only delay the failure.
          throw new Error(
            `voyage responded ${response.status}: ${await response.text()}`,
          );
        }

        const parsed = (await response.json()) as VoyageResponse;
        if (!parsed.data) {
          throw new Error(
            `voyage returned no data: ${parsed.detail ?? "(no detail)"}`,
          );
        }
        if (parsed.data.length !== texts.length) {
          throw new Error(
            `voyage returned ${parsed.data.length} vectors for ${texts.length} inputs`,
          );
        }

        // Sorted by index rather than trusted in order. The port's contract is
        // "same order as the inputs", and a silently permuted batch would
        // attach every embedding to the wrong statement — which nothing
        // downstream could detect, because every vector would still be valid.
        const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
        for (const [position, item] of ordered.entries()) {
          if (item.index !== position) {
            throw new Error(
              `voyage returned a gap in indices at position ${position}`,
            );
          }
          if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
            throw new Error(
              `voyage returned ${item.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
            );
          }
        }
        return ordered.map((item) => item.embedding);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        // Only the retryable branch above loops; anything else has already
        // been thrown.
        if (attempt >= maxRetries) throw error;
        if (!(error instanceof TypeError)) throw error;
        // A TypeError from fetch is a transport failure — DNS, connection
        // reset — and is worth another attempt.
        await delay(2 ** attempt * 500, signal);
      }
    }

    throw lastError ?? new Error("voyage: exhausted retries");
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

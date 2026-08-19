import { admitEgress, type EgressEntry } from "@standfast/core";
import { EMBEDDING_DIMENSIONS, type Embedder } from "../ports.js";

/**
 * The embedder, over an OpenAI-compatible embeddings endpoint the operator runs
 * themselves.
 *
 * It exists to close `docs/13-threat-model.md`'s *Egress* rule 4 — every
 * outbound call points at something the customer could host. voyage-3 is a
 * hosted service and nothing else, so while `voyage.ts` is the only embedder
 * that rule is a promise rather than a property of the code. A second adapter
 * is what makes it checkable; `docs/14-roadmap.md` (*Open*, "A self-hostable
 * embedding adapter") owns the item and schedules it before phase 2.
 *
 * bge-m3 is the model that fits: natively 1024 dimensions, which is what
 * migration 0002 made `atoms.embedding`, so nothing is truncated and there is
 * no Matryoshka assumption to be wrong about later.
 *
 * The request speaks the OpenAI wire format rather than any one server's,
 * because text-embeddings-inference and vLLM both serve `/v1/embeddings` and
 * agreeing with both costs one POST. Raw `fetch` for the reason `voyage.ts`
 * gives: the alternative is a client library around that one POST.
 */

export type BgeOptions = {
  /**
   * Optional, and that is the whole point of this adapter.
   *
   * A model on the operator's own network may have no credential at all, and an
   * adapter that demanded one would make the self-hostable path harder to
   * configure than the hosted path it exists to be an alternative to. Sent when
   * present, omitted when not — never defaulted to a placeholder, because a
   * server that does check would then reject with "bad key" rather than
   * "no key".
   */
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly model: string;
  /** The allowlist this adapter must be admitted by. See `AnthropicOptions`. */
  readonly allowlist: readonly EgressEntry[];
  /** Retries on 429 and 5xx. Anything else fails immediately. */
  readonly maxRetries?: number;
};

type EmbeddingsResponse = {
  data?: Array<{ embedding: number[]; index: number }>;
  error?: { message?: string };
  detail?: string;
};

export class BgeEmbedder implements Embedder {
  readonly id: string;
  readonly egress: EgressEntry;

  /**
   * bge-m3 accepts 8,192 tokens. Held at a conservative character budget
   * because this port declares characters, and the ratio is content-dependent.
   *
   * Unlike voyage-3's 80,000 this is the binding constraint, and the difference
   * is worth stating rather than discovering: `ports.ts` requires the window a
   * long section is split into to be smaller than the smaller of the
   * extractor's limit and this one, and 20,000 is an order of magnitude below
   * the extractor's 200,000. Choosing this embedder changes how a long section
   * gets split. Choosing voyage-3 did not.
   */
  readonly maxInputChars = 20_000;

  constructor(private readonly options: BgeOptions) {
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

    // No `input_type` and no instruction prefix, which is the one place this
    // adapter deliberately differs from `voyage.ts` rather than mirroring it.
    // bge-m3 embeds queries and documents into a single space; the retrieval
    // instruction its predecessors in the BGE family wanted would move every
    // atom stored through this adapter away from every atom already stored.
    const body = JSON.stringify({ input: texts, model: this.options.model });

    // Built from the entry that admitted the call, never from `options.baseURL`
    // directly. `admitEgress` compares origins and nothing else, so a path on
    // the configured URL is something it silently ignores — and a request built
    // from a string it did not fully examine is a request to a destination it
    // did not fully admit.
    const url = new URL("/v1/embeddings", this.egress.origin);

    const headers = {
      "content-type": "application/json",
      ...(this.options.apiKey
        ? { authorization: `Bearer ${this.options.apiKey}` }
        : {}),
    };

    const maxRetries = this.options.maxRetries ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal,
        });

        if (response.status === 429 || response.status >= 500) {
          // A self-hosted server returns 429 for a full queue and 503 during a
          // rolling restart. Both are the operator's own capacity, and both
          // clear on their own.
          lastError = new Error(
            `embeddings endpoint responded ${response.status}: ${await response.text()}`,
          );
          if (attempt < maxRetries) {
            await delay(2 ** attempt * 500, signal);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          // 4xx other than 429: a bad key, an unserved model name, an input
          // over the server's limit. Retrying cannot help.
          throw new Error(
            `embeddings endpoint responded ${response.status}: ${await response.text()}`,
          );
        }

        const parsed = (await response.json()) as EmbeddingsResponse;
        if (!parsed.data) {
          throw new Error(
            `embeddings endpoint returned no data: ${parsed.error?.message ?? parsed.detail ?? "(no detail)"}`,
          );
        }
        if (parsed.data.length !== texts.length) {
          throw new Error(
            `embeddings endpoint returned ${parsed.data.length} vectors for ${texts.length} inputs`,
          );
        }

        // Sorted by index rather than trusted in order, for the reason
        // `voyage.ts` gives: the port's contract is "same order as the inputs",
        // and a permuted batch attaches every embedding to the wrong statement
        // with nothing downstream able to notice, because every vector is still
        // a valid vector.
        const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
        for (const [position, item] of ordered.entries()) {
          if (item.index !== position) {
            throw new Error(
              `embeddings endpoint returned a gap in indices at position ${position}`,
            );
          }
          if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
            // Loudly, and here. A wrong-width vector is rejected by the column
            // much later and by then the error names the insert rather than the
            // model that produced it — and an operator serving whatever weights
            // they like is exactly who can produce one.
            throw new Error(
              `embeddings endpoint returned ${item.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
            );
          }
        }
        return ordered.map((item) => item.embedding);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (attempt >= maxRetries) throw error;
        if (!(error instanceof TypeError)) throw error;
        // A TypeError from fetch is a transport failure — DNS, connection
        // reset — and is worth another attempt.
        await delay(2 ** attempt * 500, signal);
      }
    }

    throw lastError ?? new Error("embeddings endpoint: exhausted retries");
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

import {
  admitEgress,
  type EgressEntry,
  EgressError,
  isLocal,
} from "@standfast/core";
import type { QueryEmbedder } from "../retrieval.js";

/**
 * Embeds the caller's query, against a model the operator runs themselves.
 *
 * This is the read path's first model call — the one `docs/06-retrieval.md`
 * names, and the one generator 1 cannot run without. It is also the most
 * sensitive call in the system, and the reason takes a moment to see: the
 * extraction path sends prose the customer already uploaded, in a queue worker,
 * at a time unrelated to anyone's keystrokes. This sends **a task description
 * typed minutes ago, while the developer waits for the answer**. An observer
 * holding that stream learns what a team is building before the team ships it —
 * which is not a fact about the code, and is not covered by any promise made
 * about the code.
 *
 * ## Two locks, and they refuse for different reasons
 *
 * **The allowlist, at configuration time.** The purpose is `query-embedding`,
 * not `embedding`, and it is deliberately absent from `PERMITTED_PURPOSES` —
 * so `parseEgressAllowlist` refuses the entry when the environment is read, and
 * the process never reaches this constructor. That is where the gate belongs:
 * it is a statement about what a deployment may be configured to do, and it
 * fires whether or not anyone remembered to construct the adapter. This class
 * calls `admitEgress` for the narrower job the worker's adapters use it for —
 * proving the entry it was handed really admits this origin and this pinned
 * model — which is why the two checks are not redundant.
 *
 * So **no deployment can reach this code today**, and that is the intended
 * state rather than an unfinished one:
 * `docs/13-threat-model.md` (*Egress*, rule 2) makes a live query stream a
 * second procurement decision needing its own consent, and
 * `docs/06-retrieval.md` condition 4 wants a measured p95 that fits inside
 * `context`'s — a number nobody can choose until a corpus exists. Four of the
 * five conditions being satisfiable is not four-fifths of permission.
 *
 * **The destination.** Even once the first lock opens, this refuses any host
 * the operator does not run. `docs/06-retrieval.md` condition 2 —
 * "operated by us, in the region of the database. Not a third-party hosted
 * endpoint" — is otherwise a sentence in a document, and a sentence in a
 * document does not stop a deployment pointing this at a hosted provider on a
 * Friday afternoon. Here it is a constructor that throws.
 *
 * `isLocal` is the same predicate the allowlist already uses to decide whether
 * plaintext is acceptable, and its own definition is "an operator running the
 * model themselves". Reusing it rather than inventing a second notion of
 * "ours" means there is one answer to that question in the codebase.
 *
 * **What this costs, stated rather than discovered.** `isLocal` accepts
 * loopback, RFC1918 ranges and bare hostnames — a container name, a service on
 * the cluster network. It does *not* accept a private DNS name with dots, such
 * as `embeddings.eu-west-1.internal.example.com`, which is a perfectly
 * legitimate in-region deployment. Such an operator has to reach the service by
 * a name this recognises. That is a real limitation, and the alternative —
 * loosening the predicate until it admits names that merely look internal — is
 * worse, because the whole value of this lock is that it cannot be talked into
 * anything.
 *
 * ## Why not the worker's embedder
 *
 * `packages/worker/src/adapters/bge.ts` speaks the same wire format, and this
 * duplicates perhaps thirty lines of it. Deliberately. That adapter batches,
 * because a four-hundred-section document would otherwise be four hundred round
 * trips; a query is one string, and a batching interface here would invite a
 * caller to think retrieval could amortise something it cannot. The two also
 * live in different deployables — the worker and the API are separate processes
 * (`docs/03-architecture.md`) — so sharing would mean a dependency between them
 * for the sake of a `fetch` and a retry loop.
 */

export type QueryEmbedderOptions = {
  /**
   * Optional, like the worker's self-hostable embedder and for the same reason:
   * a model on the operator's own network may have no credential, and demanding
   * one would make the only permitted configuration the awkward one. Never
   * defaulted to a placeholder — a server that does check would then reject with
   * "bad key" rather than "no key".
   */
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly model: string;
  readonly allowlist: readonly EgressEntry[];
};

// No timeout option. There was one, briefly, described as "bounded, because
// condition 4 is a deadline" — a knob nothing read, attesting a guarantee
// nothing provided, against the one condition that is furthest from being met.
// The deadline is the caller's `AbortSignal`, passed to `embed` and honoured by
// `fetch`; `packages/api/src/routes.ts` sets it. When condition 4 stops being
// unmeasurable, the number belongs wherever the p95 is chosen, not here.

type EmbeddingsResponse = {
  data?: Array<{ embedding: number[]; index: number }>;
  error?: { message?: string };
  detail?: string;
};

/** Fixed by `atoms.embedding vector(1024)` in migration 0002. */
const EMBEDDING_DIMENSIONS = 1024;

export class SelfHostedQueryEmbedder implements QueryEmbedder {
  readonly id: string;
  readonly egress: EgressEntry;

  constructor(private readonly options: QueryEmbedderOptions) {
    // The entry must admit this exact origin and this exact pinned model. The
    // purpose itself was already refused, if it was going to be, when the
    // allowlist was parsed — this is the narrower check the worker's adapters
    // make, and it is what stops a caller passing an entry that describes some
    // other destination.
    this.egress = admitEgress(
      options.allowlist,
      "query-embedding",
      options.baseURL,
      options.model,
    );

    const { hostname } = new URL(options.baseURL);
    if (!isLocal(hostname)) {
      throw new EgressError(
        `${hostname} is not a host this deployment runs. The query embedding is a read-path model call, and docs/06-retrieval.md condition 2 admits only a model operated by us in the region of the database — not a third-party hosted endpoint, whose latency would be somebody else's SLO and whose weights change without a version bump. Point this at a service on your own network.`,
      );
    }

    this.id = options.model;
  }

  /**
   * One vector for one query.
   *
   * Throws rather than returning null on failure. The caller
   * (`packages/api/src/retrieval.ts`) catches, records the stage as skipped and
   * carries on with three generators — condition 5 — so the decision to degrade
   * is made where it can be reported, not swallowed here where it cannot.
   */
  async embed(text: string, signal: AbortSignal): Promise<readonly number[]> {
    const response = await fetch(
      new URL("/v1/embeddings", this.egress.origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({ model: this.egress.model, input: [text] }),
        signal,
      },
    );

    if (!response.ok) {
      // No retry loop. The worker retries because a poisoned job can wait; a
      // developer holding a session cannot, and condition 4 is a deadline.
      // A failure here degrades to three generators, which is a better answer
      // than a slow one.
      throw new Error(
        `query embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as EmbeddingsResponse;
    const vector = body.data?.[0]?.embedding;

    if (!vector) {
      throw new Error(
        `query embedding returned no vector: ${body.error?.message ?? body.detail ?? "no data"}`,
      );
    }

    // Asserted here rather than left for Postgres to reject on a write that
    // never happens: this vector is compared against stored ones, and a
    // wrong-width vector would fail far from its cause.
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `query embedding has ${vector.length} dimensions and atoms.embedding is ${EMBEDDING_DIMENSIONS}. The query and the corpus were embedded by different models, and the distances between them would be arithmetic rather than meaning.`,
      );
    }

    return vector;
  }
}

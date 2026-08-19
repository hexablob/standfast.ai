import {
  describeEgress,
  type EgressEntry,
  parseEgressAllowlist,
} from "@standfast/core";
import { SelfHostedQueryEmbedder } from "./adapters/query-embedder.js";
import { NO_RETRIEVAL_PORTS, type RetrievalPorts } from "./retrieval.js";

/**
 * Resolves the read path's model calls from configuration, and refuses
 * anything the egress allowlist does not admit.
 *
 * The worker has had this since phase 1d (`packages/worker/src/main.ts`); the
 * API has not needed it, because until retrieval landed the API opened no
 * outbound socket at all. It does the same job for the same reason: the check
 * happens **before the adapter is constructed**, so a destination the allowlist
 * does not name cannot be reached even once, and the failure is a start-up
 * refusal rather than a surprise on the first request.
 *
 * The difference from the worker is what happens when nothing is configured. An
 * extraction worker with no providers runs on deterministic fakes; a read path
 * with no query embedder simply runs three generators instead of four and says
 * `"dense"` in `skipped`. That is condition 5, and it is why the absence of
 * configuration here is silent rather than fatal.
 */
export function resolveRetrievalPorts(env = process.env): {
  ports: RetrievalPorts;
  egress: EgressEntry[];
} {
  // Parsed before anything is constructed, so a malformed or forbidden entry
  // stops the process rather than being discovered on the first query.
  const egress = parseEgressAllowlist(env["STANDFAST_EGRESS_ALLOWLIST"]);

  const entry = egress.find((e) => e.purpose === "query-embedding");
  if (!entry) {
    // Not configured is not an error, and it is the state every deployment is
    // in today. Generator 1 drops out; the other three answer.
    return { ports: NO_RETRIEVAL_PORTS, egress };
  }

  // Throws unless `query-embedding` has been admitted to `PERMITTED_PURPOSES`,
  // and unless the destination is one this deployment runs. Both refusals are
  // the adapter's, deliberately: putting them in the constructor means no other
  // wiring can reach a destination this one would have refused.
  const queryEmbedder = new SelfHostedQueryEmbedder({
    allowlist: egress,
    baseURL: entry.origin,
    model: entry.model,
    ...(env["STANDFAST_QUERY_EMBEDDING_API_KEY"]
      ? { apiKey: env["STANDFAST_QUERY_EMBEDDING_API_KEY"] }
      : {}),
  });

  return {
    // The reranker stays unbound. `docs/06-retrieval.md` condition 2 wants a
    // model operated by us in the region of the database, and
    // `docs/14-roadmap.md` leaves the provider Open with an acceptance test it
    // has not been put through. The stage exists, is skippable, and is skipped.
    ports: { queryEmbedder, reranker: null },
    egress,
  };
}

/**
 * One line naming everything this process may send, and where.
 *
 * `docs/13-threat-model.md` (*Egress*, rule 3): egress is disclosable, and
 * answering "what does this deployment send, and to whom" should never require
 * reading a source file. The worker prints this at start-up; so does the API,
 * now that it has anything to print.
 */
export function describeApiEgress(egress: readonly EgressEntry[]): string {
  return describeEgress(egress);
}

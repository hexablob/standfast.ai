import { EgressError } from "@standfast/core";
import { describe, expect, it } from "vitest";
import { resolveRetrievalPorts } from "./ports.js";

/**
 * What a deployment gets when it starts.
 *
 * The first case is the one every deployment is in today, and the one CI runs
 * in: no allowlist, no ports, no socket. The rest are the ways a deployment
 * could try to change that and the refusals it meets.
 */
describe("resolveRetrievalPorts", () => {
  it("binds nothing when nothing is configured", () => {
    const { ports, egress } = resolveRetrievalPorts({});

    expect(ports.queryEmbedder).toBeNull();
    expect(egress).toEqual([]);
  });

  /**
   * An extraction deployment configures `embedding` for its worker. The API
   * reads the same allowlist and must not read that entry as permission to
   * embed queries — which is exactly what a single shared purpose would have
   * caused, silently, on every deployment that already exists.
   */
  it("does not take the worker's batch embedder as a query embedder", () => {
    const { ports, egress } = resolveRetrievalPorts({
      STANDFAST_EGRESS_ALLOWLIST: "embedding https://api.voyageai.com voyage-3",
    });

    expect(egress).toHaveLength(1);
    expect(ports.queryEmbedder).toBeNull();
  });

  it("refuses to start when a query embedder is configured at all", () => {
    // The purpose is not in PERMITTED_PURPOSES, so the allowlist parser throws
    // before any adapter exists. A start-up refusal, not a failed request.
    expect(() =>
      resolveRetrievalPorts({
        STANDFAST_EGRESS_ALLOWLIST:
          "query-embedding http://embeddings:8080 bge-m3-2026-01-01",
      }),
    ).toThrow(EgressError);
  });

  /**
   * The reranker stays unbound whatever the allowlist says, because no provider
   * is written. Pinned so that binding one is a visible change rather than a
   * side effect of configuration.
   */
  it("never binds a reranker", () => {
    const { ports } = resolveRetrievalPorts({
      STANDFAST_EGRESS_ALLOWLIST:
        "extraction https://api.anthropic.com claude-opus-5",
    });

    expect(ports.reranker).toBeNull();
  });
});

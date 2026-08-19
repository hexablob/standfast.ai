import {
  type EgressEntry,
  type EgressPurpose,
  PERMITTED_PURPOSES,
  parseEgressAllowlist,
} from "@standfast/core";
import { afterEach, describe, expect, it } from "vitest";
import { SelfHostedQueryEmbedder } from "./query-embedder.js";

const LOCAL: EgressEntry = {
  purpose: "query-embedding",
  origin: "http://embeddings:8080",
  model: "bge-m3-2026-01-01",
};

const HOSTED: EgressEntry = {
  purpose: "query-embedding",
  origin: "https://api.voyageai.com",
  model: "bge-m3-2026-01-01",
};

/**
 * Opens the first lock so the second can be tested on its own.
 *
 * `query-embedding` is absent from `PERMITTED_PURPOSES`, which is the intended
 * state and is asserted below in its own test. But a lock that has never been
 * exercised because a different lock stopped everything first is a lock nobody
 * knows the shape of. These tests open the outer one deliberately, so that the
 * destination check is proven to work on the day somebody opens it for real —
 * which is the entire reason for building it now rather than then.
 */
function withPurposePermitted<T>(fn: () => T): T {
  const list = PERMITTED_PURPOSES as EgressPurpose[];
  list.push("query-embedding");
  try {
    return fn();
  } finally {
    list.pop();
  }
}

afterEach(() => {
  expect(PERMITTED_PURPOSES).not.toContain("query-embedding");
});

describe("the first lock: a purpose no deployment may configure", () => {
  /**
   * The gate is at configuration time, in the allowlist parser, not in this
   * adapter's constructor — which is the right place for it. It is a statement
   * about what a deployment may be *configured* to do, so it fires when the
   * environment is read, whether or not anyone remembered to construct
   * anything.
   *
   * This is the state the repository is in, and the one it should stay in until
   * the conditions listed in `packages/core/src/egress.ts` are met. If this
   * test starts failing, somebody has enabled the read path's model call —
   * which may well be right, but is a decision, and this is where it gets
   * noticed.
   */
  it("cannot be put on the allowlist at all, today", () => {
    expect(() =>
      parseEgressAllowlist(
        "query-embedding http://embeddings:8080 bge-m3-2026-01-01",
      ),
    ).toThrow(/query-embedding/);
  });

  it("is refused for the same reason reranking is", () => {
    const refuse = (config: string) => {
      try {
        parseEgressAllowlist(config);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    // Both cite the same rule, because both send a live task description on
    // the read path. The batch purpose beside them parses without complaint,
    // which is the distinction the whole design turns on.
    expect(
      refuse("query-embedding http://embeddings:8080 bge-m3-2026-01-01"),
    ).toContain("13-threat-model");
    expect(
      refuse("reranking http://rerank:8080 some-model-2026-01-01"),
    ).toContain("13-threat-model");
    expect(refuse("embedding http://embeddings:8080 bge-m3-2026-01-01")).toBe(
      "",
    );
  });
});

describe("the second lock: a destination the operator does not run", () => {
  /**
   * `docs/06-retrieval.md` condition 2 — "operated by us, in the region of the
   * database. Not a third-party hosted endpoint." Otherwise a sentence in a
   * document; here a constructor that throws.
   */
  it("refuses a hosted provider even once the purpose is permitted", () => {
    withPurposePermitted(() => {
      expect(
        () =>
          new SelfHostedQueryEmbedder({
            allowlist: [HOSTED],
            baseURL: HOSTED.origin,
            model: HOSTED.model,
          }),
      ).toThrow(/not a host this deployment runs/);
    });
  });

  it("accepts a service on the operator's own network", () => {
    withPurposePermitted(() => {
      const port = new SelfHostedQueryEmbedder({
        allowlist: [LOCAL],
        baseURL: LOCAL.origin,
        model: LOCAL.model,
      });

      expect(port.id).toBe(LOCAL.model);
      // The entry it reports is the one it asserted itself against, so the
      // record of what left cannot describe one destination while the socket
      // opens on another.
      expect(port.egress).toBe(LOCAL);
    });
  });

  it.each([
    ["a loopback address", "http://127.0.0.1:8080"],
    ["a private range", "http://10.1.2.3:8080"],
    ["a bare service name", "http://tei"],
  ])("accepts %s", (_name, origin) => {
    withPurposePermitted(() => {
      const entry: EgressEntry = { ...LOCAL, origin };
      expect(
        () =>
          new SelfHostedQueryEmbedder({
            allowlist: [entry],
            baseURL: origin,
            model: entry.model,
          }),
      ).not.toThrow();
    });
  });
});

describe("embedding a query", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  function embedderWith(response: unknown, status = 200) {
    const calls: { url: string; body: unknown; auth?: string }[] = [];
    globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        ...(headers["authorization"] === undefined
          ? {}
          : { auth: headers["authorization"] }),
      });
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const port = withPurposePermitted(
      () =>
        new SelfHostedQueryEmbedder({
          allowlist: [LOCAL],
          baseURL: LOCAL.origin,
          model: LOCAL.model,
        }),
    );
    return { port, calls };
  }

  const vector = (n: number) => Array.from({ length: n }, (_, i) => i / n);

  it("sends the query to the admitted origin and returns its vector", async () => {
    const { port, calls } = embedderWith({
      data: [{ embedding: vector(1024), index: 0 }],
    });

    const got = await port.embed(
      "add 2FA to checkout",
      AbortSignal.timeout(1000),
    );

    expect(got).toHaveLength(1024);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://embeddings:8080/v1/embeddings");
    // The pinned model, from the allowlist entry — never from a caller.
    expect((calls[0] as { body: { model: string } }).body.model).toBe(
      LOCAL.model,
    );
  });

  it("sends no credential when none was configured", async () => {
    const { port, calls } = embedderWith({
      data: [{ embedding: vector(1024), index: 0 }],
    });

    await port.embed("a query", AbortSignal.timeout(1000));

    expect(calls).toHaveLength(1);
    // Absent, not a placeholder: a server that does check would answer
    // "bad key" rather than "no key", which sends somebody to the wrong fix.
    expect(calls[0]?.auth).toBeUndefined();
  });

  /**
   * The query and the corpus have to live in one space. A vector of the wrong
   * width would otherwise reach the distance computation and produce numbers
   * that are arithmetic rather than meaning — and the failure would surface as
   * bad ranking, a long way from its cause.
   */
  it("refuses a vector that is not the width of the column", async () => {
    const { port } = embedderWith({
      data: [{ embedding: vector(768), index: 0 }],
    });

    await expect(
      port.embed("a query", AbortSignal.timeout(1000)),
    ).rejects.toThrow(/768 dimensions/);
  });

  it("throws rather than degrading, and leaves that decision to its caller", async () => {
    const { port } = embedderWith({ error: { message: "model loading" } }, 503);

    // `packages/api/src/retrieval.ts` catches this, reports "dense" as skipped
    // and answers with three generators. Degrading here would hide the skip
    // from the response, which condition 5 requires to be visible.
    await expect(
      port.embed("a query", AbortSignal.timeout(1000)),
    ).rejects.toThrow(/503/);
  });
});

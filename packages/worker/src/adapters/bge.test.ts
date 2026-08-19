import { type EgressEntry, EgressError } from "@standfast/core";
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../ports.js";
import { BgeEmbedder } from "./bge.js";
import { fixtureVector } from "./fixtures.js";

/**
 * Contract tests for the self-hostable embedder.
 *
 * No socket is opened: the adapter calls global `fetch`, so the stub is
 * installed around each call. What is under test is the reading of an
 * OpenAI-compatible response and the refusal of everything else — not that the
 * shape is right, which is `fixtures.ts`'s problem.
 */

const NEVER_ABORTED = new AbortController().signal;

/**
 * The allowlist these tests construct against.
 *
 * A self-hosted origin, because that is the case this adapter exists for:
 * `docs/13-threat-model.md` (*Egress*, rule 4) is only satisfied if the
 * embedder works against something the operator runs.
 */
const ALLOWLIST: readonly EgressEntry[] = [
  { purpose: "embedding", origin: "http://tei:8080", model: "bge-m3" },
];

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{
    url: string;
    headers: { authorization?: string };
    body: unknown;
  }> = [];
  let index = 0;
  const impl = (async (input: unknown, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as { authorization?: string },
      body: typeof raw === "string" ? JSON.parse(raw) : raw,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/** The embedder uses global fetch, so the stub is installed around the call. */
async function withFetch<T>(
  impl: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** A permuted two-vector response, as a server under batching may return it. */
const PERMUTED_RESPONSE = {
  object: "list",
  model: "bge-m3",
  data: [
    { object: "embedding", index: 1, embedding: fixtureVector(2) },
    { object: "embedding", index: 0, embedding: fixtureVector(1) },
  ],
};

describe("BgeEmbedder", () => {
  function embedder(
    responses: Array<{ status: number; body: unknown }>,
    options: { apiKey?: string; baseURL?: string } = {},
  ) {
    const stub = stubFetch(responses);
    return {
      port: new BgeEmbedder({
        allowlist: ALLOWLIST,
        baseURL: options.baseURL ?? "http://tei:8080",
        model: "bge-m3",
        maxRetries: 2,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      }),
      stub,
    };
  }

  it("cannot be constructed for an origin the allowlist does not admit", () => {
    // The property the whole adapter rests on: a second wiring — a test, the
    // evaluation harness, a future process — cannot point it somewhere else.
    expect(
      () =>
        new BgeEmbedder({
          allowlist: ALLOWLIST,
          baseURL: "https://embeddings.example.com",
          model: "bge-m3",
        }),
    ).toThrow(EgressError);
  });

  it("cannot be constructed for a model the allowlist does not pin", () => {
    expect(
      () =>
        new BgeEmbedder({
          allowlist: ALLOWLIST,
          baseURL: "http://tei:8080",
          model: "bge-large-en-v1.5",
        }),
    ).toThrow(EgressError);
  });

  it("returns vectors in input order, not response order", async () => {
    // A batch reattached in arrival order gives every statement somebody else's
    // embedding — undetectable downstream, because every vector is still valid.
    const { port, stub } = embedder([{ status: 200, body: PERMUTED_RESPONSE }]);
    const got = await withFetch(stub.fetch, () =>
      port.embed(["first", "second"], NEVER_ABORTED),
    );

    expect(got[0]).toEqual(fixtureVector(1));
    expect(got[1]).toEqual(fixtureVector(2));
  });

  it("refuses a vector of the wrong width", async () => {
    // An operator serves whatever weights they like. A 768-wide model is a
    // plausible mistake, and the column would report it far from its cause.
    const { port, stub } = embedder([
      {
        status: 200,
        body: {
          object: "list",
          model: "bge-m3",
          data: [
            { object: "embedding", index: 0, embedding: Array(768).fill(0) },
          ],
        },
      },
    ]);
    await expect(
      withFetch(stub.fetch, () => port.embed(["a"], NEVER_ABORTED)),
    ).rejects.toThrow(new RegExp(`expected ${EMBEDDING_DIMENSIONS}`));
  });

  it("refuses a short batch rather than returning a short array", async () => {
    const { port, stub } = embedder([
      {
        status: 200,
        body: {
          object: "list",
          model: "bge-m3",
          data: [
            { object: "embedding", index: 0, embedding: fixtureVector(1) },
          ],
        },
      },
    ]);
    await expect(
      withFetch(stub.fetch, () => port.embed(["a", "b"], NEVER_ABORTED)),
    ).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("sends no authorization header when no credential is configured", async () => {
    // The case this adapter exists for. A placeholder credential would turn
    // "no key" into "bad key" on a server that checks.
    const { port, stub } = embedder([{ status: 200, body: PERMUTED_RESPONSE }]);
    await withFetch(stub.fetch, () => port.embed(["a", "b"], NEVER_ABORTED));

    // Asserted before the header, and the reason is that `calls[0]?.` is
    // undefined both when the header was absent and when no request happened
    // at all. Without this line the test passes on an adapter that never
    // called fetch, which is the one outcome it must not accept.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("sends the credential when the caller supplies one", async () => {
    const { port, stub } = embedder(
      [{ status: 200, body: PERMUTED_RESPONSE }],
      {
        apiKey: "secret",
      },
    );
    await withFetch(stub.fetch, () => port.embed(["a", "b"], NEVER_ABORTED));

    expect(stub.calls[0]?.headers.authorization).toBe("Bearer secret");
  });

  it("posts to the admitted origin even when the configured URL has a path", async () => {
    // `admitEgress` compares origins and ignores paths, so a path left on the
    // configured URL would otherwise reach a route nothing checked.
    const { port, stub } = embedder(
      [{ status: 200, body: PERMUTED_RESPONSE }],
      {
        baseURL: "http://tei:8080/inference/",
      },
    );
    await withFetch(stub.fetch, () => port.embed(["a", "b"], NEVER_ABORTED));

    expect(stub.calls[0]?.url).toBe("http://tei:8080/v1/embeddings");
  });

  it("sends no instruction prefix or input_type", async () => {
    // bge-m3 shares one space between queries and documents. A prefix here
    // would place stored atoms away from every atom already stored.
    const { port, stub } = embedder([{ status: 200, body: PERMUTED_RESPONSE }]);
    await withFetch(stub.fetch, () =>
      port.embed(["first", "second"], NEVER_ABORTED),
    );

    const body = stub.calls[0]?.body as {
      input: string[];
      model: string;
      input_type?: string;
    };
    expect(body.input).toEqual(["first", "second"]);
    expect(body.model).toBe("bge-m3");
    expect(body.input_type).toBeUndefined();
  });

  it("retries a 429 rather than failing the section", async () => {
    // A full queue on the operator's own box is capacity, not an error.
    const { port, stub } = embedder([
      { status: 429, body: { error: { message: "queue full" } } },
      { status: 200, body: PERMUTED_RESPONSE },
    ]);
    const got = await withFetch(stub.fetch, () =>
      port.embed(["a", "b"], NEVER_ABORTED),
    );

    expect(got).toHaveLength(2);
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a 401", async () => {
    // A bad key cannot become a good key. Retrying only delays the failure and
    // burns the lease on the section being extracted.
    const { port, stub } = embedder([
      { status: 401, body: { error: { message: "bad key" } } },
    ]);
    await expect(
      withFetch(stub.fetch, () => port.embed(["a"], NEVER_ABORTED)),
    ).rejects.toThrow(/401/);
    expect(stub.calls).toHaveLength(1);
  });

  it("does not call anybody once the signal is aborted", async () => {
    const { port, stub } = embedder([{ status: 200, body: PERMUTED_RESPONSE }]);
    await expect(
      withFetch(stub.fetch, () => port.embed(["a"], AbortSignal.abort())),
    ).rejects.toThrow();
    expect(stub.calls).toEqual([]);
  });

  it("returns nothing for an empty batch without calling anybody", async () => {
    const { port, stub } = embedder([]);
    const got = await withFetch(stub.fetch, () =>
      port.embed([], NEVER_ABORTED),
    );
    expect(got).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  /**
   * The three readonly properties of the port, which nothing above touches.
   *
   * Each one is load-bearing somewhere else in the system, and each fails
   * silently rather than loudly if it is wrong — which is exactly the shape of
   * defect a contract test exists to catch.
   */
  it("names itself, so extractor_version records which embedder ran", () => {
    const { port } = embedder([]);

    // Identity, never dispatch (ports.ts). It feeds the extractor version, so
    // an empty or colliding id would make two different configurations
    // indistinguishable in a corpus somebody later tries to reproduce.
    expect(port.id).toContain("bge");
    expect(port.id).not.toBe("");
  });

  it("declares the allowlist entry it was admitted against, not a copy", () => {
    const { port } = embedder([]);

    // `ports.ts`: the entry an adapter reports is the same object it asserted
    // itself against, so the record of what left cannot describe one
    // destination while the socket opens on another. Identity, not equality.
    expect(port.egress).toBe(ALLOWLIST[0]);
  });

  it("declares a window smaller than the extractor's, and means it", () => {
    const { port } = embedder([]);

    // The binding constraint on how a long section is split: the extractor
    // accepts 200,000 characters and this accepts far fewer, so choosing this
    // embedder changes the window. Asserted rather than left in a comment,
    // because a limit nothing checks is a limit that drifts.
    expect(port.maxInputChars).toBe(20_000);
    expect(port.maxInputChars).toBeLessThan(200_000);
  });
});

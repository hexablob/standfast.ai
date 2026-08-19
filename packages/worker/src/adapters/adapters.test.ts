import { type EgressEntry, EgressError } from "@standfast/core";
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../ports.js";
import {
  AnthropicExtractor,
  AnthropicJudge,
  RefusedError,
} from "./anthropic.js";
import {
  ANTHROPIC_EXTRACTION_RESPONSE,
  ANTHROPIC_JUDGE_RESPONSE,
  ANTHROPIC_REFUSAL_RESPONSE,
  ANTHROPIC_TRUNCATED_RESPONSE,
  fixtureVector,
  VOYAGE_EMBEDDINGS_RESPONSE,
} from "./fixtures.js";
import { VoyageEmbedder } from "./voyage.js";

/**
 * Contract tests against hand-authored fixtures.
 *
 * They assert that these adapters read the documented response shape correctly
 * and refuse everything else. They do not assert that the shape is right — see
 * `fixtures.ts`.
 */

const NEVER_ABORTED = new AbortController().signal;

const SECTION = {
  headingPath: ["Conventions"],
  body: "Deploys happen on Fridays, and every migration must be reversible.",
};

/** A fetch that answers from a fixture and records what it was asked. */
function stubFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let index = 0;
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: string }).url ?? input);
    const raw = init?.body;
    calls.push({
      url,
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

/**
 * The allowlist these tests construct against.
 *
 * Spelled out rather than defaulted, because "an adapter cannot be built for a
 * destination the allowlist does not admit" is the property under test, and a
 * helper that quietly supplied one would be the thing that makes it untrue.
 */
const ALLOWLIST: readonly EgressEntry[] = [
  {
    purpose: "extraction",
    origin: "https://api.example.com",
    model: "claude-opus-5",
  },
  {
    purpose: "judge",
    origin: "https://api.example.com",
    model: "claude-sonnet-5",
  },
  {
    purpose: "embedding",
    origin: "https://voyage.example.com",
    model: "voyage-3",
  },
];

describe("the allowlist, at the adapter", () => {
  it("refuses an origin the allowlist does not admit", () => {
    expect(
      () =>
        new AnthropicExtractor({
          apiKey: "test",
          allowlist: ALLOWLIST,
          baseURL: "https://elsewhere.example.com",
          model: "claude-opus-5",
        }),
    ).toThrow(EgressError);
  });

  it("refuses a model the allowlist does not pin", () => {
    expect(
      () =>
        new VoyageEmbedder({
          apiKey: "test",
          allowlist: ALLOWLIST,
          baseURL: "https://voyage.example.com",
          model: "voyage-4",
        }),
    ).toThrow(EgressError);
  });

  it("refuses a purpose with no entry at all", () => {
    expect(
      () =>
        new AnthropicJudge({
          apiKey: "test",
          allowlist: ALLOWLIST.filter((e) => e.purpose !== "judge"),
          baseURL: "https://api.example.com",
          model: "claude-sonnet-5",
        }),
    ).toThrow(EgressError);
  });

  it("carries the entry that admitted it, so a row cannot name another", () => {
    const port = new AnthropicExtractor({
      apiKey: "test",
      allowlist: ALLOWLIST,
      baseURL: "https://api.example.com",
      model: "claude-opus-5",
    });
    expect(port.egress).toEqual({
      purpose: "extraction",
      origin: "https://api.example.com",
      model: "claude-opus-5",
    });
  });

  it("distinguishes the judge from the extractor on one origin", () => {
    // Same host, different entries. A judge built against the extraction pin
    // would disclose the wrong model version for every adjudication.
    expect(
      () =>
        new AnthropicJudge({
          apiKey: "test",
          allowlist: ALLOWLIST,
          baseURL: "https://api.example.com",
          model: "claude-opus-5",
        }),
    ).toThrow(EgressError);
  });
});

describe("AnthropicExtractor", () => {
  function extractor(responses: Array<{ status: number; body: unknown }>) {
    const stub = stubFetch(responses);
    return {
      port: new AnthropicExtractor({
        apiKey: "test",
        allowlist: ALLOWLIST,
        baseURL: "https://api.example.com",
        model: "claude-opus-5",
        fetch: stub.fetch,
      }),
      calls: stub.calls,
    };
  }

  it("reads candidates in the order the model listed them", async () => {
    const { port } = extractor([
      { status: 200, body: ANTHROPIC_EXTRACTION_RESPONSE },
    ]);
    const got = await port.extract(SECTION, NEVER_ABORTED);

    expect(got.map((c) => c.quote)).toEqual([
      "Deploys happen on Fridays",
      "every migration must be reversible",
    ]);
    expect(got.map((c) => c.kind)).toEqual(["convention", "constraint"]);
  });

  it("sends no sampling parameters and no fallbacks", async () => {
    const { port, calls } = extractor([
      { status: 200, body: ANTHROPIC_EXTRACTION_RESPONSE },
    ]);
    await port.extract(SECTION, NEVER_ABORTED);

    const body = calls[0]?.body as Record<string, unknown>;
    // Removed on this model family — sending any of them is a 400.
    expect(body["temperature"]).toBeUndefined();
    expect(body["top_p"]).toBeUndefined();
    expect(body["top_k"]).toBeUndefined();
    // Deliberate: a server-side fallback would attribute one model's output to
    // the model extractor_version names. See the comment in anthropic.ts.
    expect(body["fallbacks"]).toBeUndefined();
  });

  it("constrains the output to the candidate schema", async () => {
    const { port, calls } = extractor([
      { status: 200, body: ANTHROPIC_EXTRACTION_RESPONSE },
    ]);
    await port.extract(SECTION, NEVER_ABORTED);

    const body = calls[0]?.body as
      | { output_config: Record<string, unknown> }
      | undefined;
    const format = body?.output_config["format"] as {
      type: string;
      schema: unknown;
    };
    expect(format.type).toBe("json_schema");
    expect(JSON.stringify(format.schema)).toContain("constraint");
  });

  it("surfaces a refusal as a refusal, with its category", async () => {
    // A declined section is a section-level outcome. It becomes a failed
    // extraction a human can see, not a crashed worker and not silence.
    const { port } = extractor([
      { status: 200, body: ANTHROPIC_REFUSAL_RESPONSE },
    ]);
    await expect(port.extract(SECTION, NEVER_ABORTED)).rejects.toThrow(
      RefusedError,
    );
    await expect(port.extract(SECTION, NEVER_ABORTED)).rejects.toThrow(/cyber/);
  });

  it("refuses truncated output rather than parsing what arrived", async () => {
    // A partial candidate list parses into a shorter list that looks complete.
    const { port } = extractor([
      { status: 200, body: ANTHROPIC_TRUNCATED_RESPONSE },
    ]);
    await expect(port.extract(SECTION, NEVER_ABORTED)).rejects.toThrow(
      /truncated/,
    );
  });

  it("refuses a section above its window rather than truncating it", async () => {
    const { port } = extractor([
      { status: 200, body: ANTHROPIC_EXTRACTION_RESPONSE },
    ]);
    await expect(
      port.extract(
        { headingPath: [], body: "x".repeat(200_001) },
        NEVER_ABORTED,
      ),
    ).rejects.toThrow(/above this extractor/);
  });

  it("is identified by its model alone", async () => {
    // The prompt version is its own component of extractorVersion; folding it
    // into the id would count it twice and disagree with the allowlist pin.
    const { port } = extractor([]);
    expect(port.id).toBe("claude-opus-5");
  });
});

describe("AnthropicJudge", () => {
  it("returns the verdict the model reached", async () => {
    const stub = stubFetch([{ status: 200, body: ANTHROPIC_JUDGE_RESPONSE }]);
    const judge = new AnthropicJudge({
      apiKey: "test",
      allowlist: ALLOWLIST,
      baseURL: "https://api.example.com",
      model: "claude-sonnet-5",
      fetch: stub.fetch,
    });

    const verdict = await judge.adjudicate(
      {
        candidate: "Migrations are reversible.",
        incumbent: "Migrations are tested.",
      },
      NEVER_ABORTED,
    );
    expect(verdict).toBe("different-claim");

    // Prompted to falsify: asking for support finds support, and these two
    // statements arrived here for being similar.
    const body = stub.calls[0]?.body as { system: string };
    expect(body.system).toMatch(/rule differently/);
  });
});

describe("VoyageEmbedder", () => {
  function embedder(responses: Array<{ status: number; body: unknown }>) {
    const stub = stubFetch(responses);
    return {
      port: new VoyageEmbedder({
        apiKey: "test",
        allowlist: ALLOWLIST,
        baseURL: "https://voyage.example.com",
        model: "voyage-3",
        maxRetries: 2,
      }),
      stub,
    };
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

  it("returns vectors in input order, not response order", async () => {
    // The fixture is deliberately permuted. A batch reattached in arrival order
    // would give every statement somebody else's embedding — undetectable
    // downstream, because every vector would still be a valid vector.
    const { port, stub } = embedder([
      { status: 200, body: VOYAGE_EMBEDDINGS_RESPONSE },
    ]);
    const got = await withFetch(stub.fetch, () =>
      port.embed(["first", "second"], NEVER_ABORTED),
    );

    expect(got[0]).toEqual(fixtureVector(1));
    expect(got[1]).toEqual(fixtureVector(2));
  });

  it("asks for document embeddings, not query embeddings", async () => {
    // Voyage embeds the two asymmetrically. Storing atoms on the query side
    // would put them in a different part of the space from every atom already
    // stored, and the dedup bands would quietly stop meaning anything.
    const { port, stub } = embedder([
      { status: 200, body: VOYAGE_EMBEDDINGS_RESPONSE },
    ]);
    await withFetch(stub.fetch, () => port.embed(["a", "b"], NEVER_ABORTED));

    const body = stub.calls[0]?.body as { input_type: string; model: string };
    expect(body.input_type).toBe("document");
    expect(body.model).toBe("voyage-3");
  });

  it("refuses a vector of the wrong width", async () => {
    const { port, stub } = embedder([
      {
        status: 200,
        body: {
          data: [{ object: "embedding", index: 0, embedding: [1, 2, 3] }],
          model: "voyage-3",
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
          data: [
            { object: "embedding", index: 0, embedding: fixtureVector(1) },
          ],
          model: "voyage-3",
        },
      },
    ]);
    await expect(
      withFetch(stub.fetch, () => port.embed(["a", "b"], NEVER_ABORTED)),
    ).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("retries a 429 and then succeeds", async () => {
    const { port, stub } = embedder([
      { status: 429, body: { detail: "slow down" } },
      { status: 200, body: VOYAGE_EMBEDDINGS_RESPONSE },
    ]);
    const got = await withFetch(stub.fetch, () =>
      port.embed(["first", "second"], NEVER_ABORTED),
    );
    expect(got).toHaveLength(2);
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a 401", async () => {
    // A bad key cannot become a good key. Retrying only delays the failure and
    // burns the lease on the section being extracted.
    const { port, stub } = embedder([
      { status: 401, body: { detail: "bad key" } },
    ]);
    await expect(
      withFetch(stub.fetch, () => port.embed(["a"], NEVER_ABORTED)),
    ).rejects.toThrow(/401/);
    expect(stub.calls).toHaveLength(1);
  });

  it("returns nothing for an empty batch without calling anybody", async () => {
    const { port, stub } = embedder([]);
    const got = await withFetch(stub.fetch, () =>
      port.embed([], NEVER_ABORTED),
    );
    expect(got).toEqual([]);
    expect(stub.calls).toEqual([]);
  });
});

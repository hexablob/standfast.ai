import { describe, expect, it } from "vitest";
import {
  assertEgressAllowed,
  describeEgress,
  EgressError,
  PERMITTED_PURPOSES,
  parseEgressAllowlist,
} from "./egress.js";

const REAL = "extraction https://api.example.com model-2026-01-01";

describe("parseEgressAllowlist", () => {
  it("treats an absent allowlist as an empty one, not an error", () => {
    // The correct configuration for a deployment that makes no outbound call,
    // which is every phase-1c deployment.
    expect(parseEgressAllowlist(undefined)).toEqual([]);
    expect(parseEgressAllowlist("   ")).toEqual([]);
  });

  it("reads entries separated by lines or semicolons, with comments", () => {
    const parsed = parseEgressAllowlist(`
      # what may be called
      extraction https://api.example.com model-a-2026-01-01
      embedding  https://embed.example.com model-b-2026-01-01 ; # trailing
    `);
    expect(parsed).toEqual([
      {
        purpose: "extraction",
        origin: "https://api.example.com",
        model: "model-a-2026-01-01",
      },
      {
        purpose: "embedding",
        origin: "https://embed.example.com",
        model: "model-b-2026-01-01",
      },
    ]);
  });

  it("keeps only the origin, so a path cannot smuggle a second destination", () => {
    const [entry] = parseEgressAllowlist(
      "extraction https://api.example.com/v1/messages model-2026-01-01",
    );
    expect(entry?.origin).toBe("https://api.example.com");
  });

  it("refuses a reranking entry, because that is phase 2's consent", () => {
    // Rule 2. Rows one to three send stored prose in a batch job; reranking
    // sends a task description typed minutes ago, in real time. Adding a line
    // to a phase-1 deployment's config must not be able to switch that on.
    expect(() =>
      parseEgressAllowlist("reranking https://rerank.example.com model-2026"),
    ).toThrow(/rule 2/);
  });

  it("refuses a query-embedding entry, on the same terms", () => {
    // The read path has two model calls, not one, and both send the live task
    // description that rule 2 is about. `embedding` is permitted because it
    // embeds atoms — stored prose, in a queue worker, at a time unrelated to
    // anyone's keystrokes. Embedding the *query* is the other thing, and
    // reusing the permitted purpose for it would stretch a consent granted for
    // an overnight job to cover the live stream, with nothing failing.
    expect(() =>
      parseEgressAllowlist(
        "query-embedding http://embeddings:8080 bge-m3-2026-01-01",
      ),
    ).toThrow(/rule 2/);
  });

  it("still admits the batch embedding purpose beside it", () => {
    // The distinction the whole design turns on. If this ever starts throwing,
    // extraction has lost its embedder; if the test above stops throwing, the
    // read path has gained one. They are separate purposes so that neither
    // change can be mistaken for the other.
    expect(() =>
      parseEgressAllowlist(
        "embedding http://embeddings:8080 bge-m3-2026-01-01",
      ),
    ).not.toThrow();
  });

  /**
   * A change detector, and deliberately so.
   *
   * `PERMITTED_PURPOSES` is the switch that decides whether this deployment may
   * be configured to send a developer's live query anywhere. Adding a purpose
   * to it is a procurement decision — `docs/13-threat-model.md` (*Egress*,
   * rule 2) — and `docs/06-retrieval.md` condition 4 additionally wants a
   * measured p95 that nobody can measure until a corpus exists.
   *
   * So this test exists to fail on the diff that flips it. It is not asserting
   * that the current list is right forever; it is making the change impossible
   * to land without someone reading the conditions in `egress.ts` and saying
   * out loud that they are met.
   */
  it("permits exactly the three batch purposes, and no read-path one", () => {
    expect([...PERMITTED_PURPOSES].sort()).toEqual([
      "embedding",
      "extraction",
      "judge",
    ]);
  });

  it("refuses a floating model alias", () => {
    // Rule 1 pins a version, and principle 12 refuses to execute whatever was
    // published most recently. A floating alias makes an entry stop describing
    // what it admitted without the entry changing.
    expect(() =>
      parseEgressAllowlist("extraction https://api.example.com model-latest"),
    ).toThrow(/floating alias/);
    expect(() =>
      parseEgressAllowlist("extraction https://api.example.com latest"),
    ).toThrow(/floating alias/);
  });

  it("refuses plaintext to the public internet and admits it locally", () => {
    // Rule 4 needs http against something the operator runs. It does not need
    // http to somebody else's server.
    expect(() =>
      parseEgressAllowlist("embedding http://api.example.com model-2026"),
    ).toThrow(/plaintext and not local/);

    for (const local of [
      "http://localhost:11434",
      "http://127.0.0.1:8080",
      "http://ollama:11434",
      "http://10.1.2.3:9000",
      "http://192.168.1.9:9000",
    ]) {
      expect(
        parseEgressAllowlist(`embedding ${local} bge-m3-2026-01-01`),
      ).toHaveLength(1);
    }
  });

  it("refuses two destinations for one purpose", () => {
    expect(() =>
      parseEgressAllowlist(
        "extraction https://a.example.com m-1; extraction https://b.example.com m-2",
      ),
    ).toThrow(/configured twice/);
  });

  it("refuses a malformed entry rather than guessing", () => {
    expect(() =>
      parseEgressAllowlist("extraction https://a.example.com"),
    ).toThrow(EgressError);
    expect(() =>
      parseEgressAllowlist("nonsense https://a.example.com m"),
    ).toThrow(/unknown egress purpose/);
    expect(() => parseEgressAllowlist("extraction not-a-url m")).toThrow(
      /not a URL/,
    );
    expect(() =>
      parseEgressAllowlist("extraction ftp://a.example.com m"),
    ).toThrow(/http or https/);
  });
});

describe("assertEgressAllowed", () => {
  const allowlist = parseEgressAllowlist(REAL);

  it("admits exactly what was configured", () => {
    expect(() =>
      assertEgressAllowed(
        allowlist,
        "extraction",
        "https://api.example.com/v1/messages",
        "model-2026-01-01",
      ),
    ).not.toThrow();
  });

  it("refuses a purpose with no entry", () => {
    // The default answer, and the one that matters: a deployment that has not
    // been configured to call anything calls nothing.
    expect(() =>
      assertEgressAllowed([], "embedding", "https://api.example.com", "m"),
    ).toThrow(/no egress allowlist entry for embedding/);
  });

  it("refuses a destination the list does not name", () => {
    expect(() =>
      assertEgressAllowed(
        allowlist,
        "extraction",
        "https://evil.example.com/v1",
        "model-2026-01-01",
      ),
    ).toThrow(/allowlist admits https:\/\/api\.example\.com/);
  });

  it("refuses a model the list does not pin", () => {
    expect(() =>
      assertEgressAllowed(
        allowlist,
        "extraction",
        "https://api.example.com",
        "model-2027-06-01",
      ),
    ).toThrow(/allowlist pins model-2026-01-01/);
  });
});

describe("describeEgress", () => {
  it("says plainly when nothing leaves", () => {
    expect(describeEgress([])).toMatch(/nothing/);
  });

  it("names every destination without anyone reading code", () => {
    // Rule 3. If answering "what left, and to whom" needs a source file, the
    // answer is not good enough.
    const text = describeEgress(
      parseEgressAllowlist(
        "embedding https://embed.example.com e-2026-01-01; extraction https://api.example.com x-2026-01-01",
      ),
    );
    expect(text).toContain(
      "extraction -> https://api.example.com (x-2026-01-01)",
    );
    expect(text).toContain(
      "embedding -> https://embed.example.com (e-2026-01-01)",
    );
    // Sorted, so two deployments with the same policy print the same thing.
    expect(text.indexOf("embedding")).toBeLessThan(text.indexOf("extraction"));
  });
});

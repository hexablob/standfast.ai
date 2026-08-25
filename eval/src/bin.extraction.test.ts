import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The exit-code contract of `pnpm eval extraction`: a successfully written
 * worksheet is the command's success and exits 0. `docs/12-evaluation.md`
 * reserves 1 for a failure or a regression, and an unadjudicated worksheet is
 * neither — `score` is where either can still happen.
 *
 * Everything mocked below is a machine test fixture: canned modules standing
 * in for a database, three real providers and the corpus. None of it is corpus
 * or label content, which only a human writes.
 */

vi.mock("./preconditions.js", () => ({
  databaseAvailable: () => ({
    name: "database",
    met: true,
    reason: "machine test fixture",
  }),
  extractorAvailable: () => ({
    name: "extractor",
    met: true,
    reason: "machine test fixture",
  }),
}));

vi.mock("./runner.js", () => ({
  RunnerError: class RunnerError extends Error {},
  evalDatabaseUrl: () => "postgres://machine-test-fixture",
  runExtraction: async () => ({
    adjudications: [
      {
        sectionHash: "a".repeat(64),
        statement: "fixture statement",
        kind: "decision",
        quote: "fixture quote",
        verdict: null,
      },
    ],
    expectedAtomIds: [`${"a".repeat(64)}#0`],
    coverage: { self: 0, public: 1, synthetic: 0 },
    documents: ["public/fixture"],
    tenant: { orgId: "org", actorId: "actor", projectId: "project" },
  }),
}));

vi.mock("./corpus.js", () => ({
  loadCorpus: () => ({
    manifest: { version: 1, allowlist: [], documents: [] },
    documents: [],
    revision: "fixture-revision",
  }),
  checkCorpus: () => [],
}));

vi.mock("./labels.js", async (importOriginal) => ({
  // The real module keeps ATOM_KINDS and the pure helpers, which edits.ts and
  // run.ts import; only the disk readers are canned.
  ...(await importOriginal<typeof import("./labels.js")>()),
  loadLabels: () => [
    {
      version: 1,
      document: "public/fixture",
      documentHash: "b".repeat(64),
      labeller: "fixture",
      labelledOn: "2026-01-01",
      blind: true,
      modelAssisted: false,
      sections: [],
    },
  ],
  checkLabels: () => [],
  coverage: () => [],
}));

vi.mock("@standfast/worker", () => ({
  resolvePorts: () => ({
    ports: {
      extractor: { id: "fixture-extractor" },
      embedder: { id: "fixture-embedder" },
      judge: { id: "fixture-judge" },
    },
    egress: [],
  }),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: vi.fn(),
}));

import { writeFileSync } from "node:fs";
import { main } from "./bin.js";

const written: string[] = [];
const write = process.stdout.write;

afterEach(() => {
  process.stdout.write = write;
  written.length = 0;
  vi.mocked(writeFileSync).mockClear();
});

describe("pnpm eval extraction", () => {
  it("exits 0 after successfully writing the worksheet", async () => {
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const code = await main(["extraction"]);
    process.stdout.write = write;

    expect(code).toBe(0);

    const paths = vi
      .mocked(writeFileSync)
      .mock.calls.map(([path]) => String(path));
    expect(paths.some((path) => path.includes("-extraction-"))).toBe(true);

    const output = written.join("");
    expect(output).toContain("Every verdict is null");
    expect(output).toContain("pnpm eval score");
  });
});

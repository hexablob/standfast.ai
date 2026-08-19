/**
 * Runs the extraction worker as a process.
 *
 *   pnpm --filter @standfast/worker run start
 *
 * A separate process, not a mode of the API. docs/03-architecture.md left that
 * open "until phase 1", and this closes it: extraction holds a model call open
 * for seconds at a time, and a pod sized for that is not a pod sized for a
 * request that must answer inside a p95. Sharing one process would also mean a
 * poison job's memory pressure lands on the read path.
 */
import {
  assertEgressAllowed,
  describeEgress,
  type EgressEntry,
  FAKE_PORT_IDS,
  parseEgressAllowlist,
} from "@standfast/core";
import {
  assertTenantIsolationApplies,
  closePool,
  extractionPortIds,
  getBoss,
  SECTION_EXTRACT_QUEUE,
  type SectionExtractJob,
  stopBoss,
} from "@standfast/db";
import { AnthropicExtractor, AnthropicJudge } from "./adapters/anthropic.js";
import { BgeEmbedder } from "./adapters/bge.js";
import { PROMPT_VERSION } from "./adapters/prompts.js";
import { VoyageEmbedder } from "./adapters/voyage.js";
import { fakePorts } from "./fakes.js";
import { makeSectionExtractHandler } from "./handler.js";
import type { Ports } from "./ports.js";

function credential(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is not set, and the egress allowlist admits a destination that needs it. A worker that starts without its credential fails on the first job instead of at boot.`,
    );
  }
  return value;
}

/**
 * Chooses between the hosted embedder and the self-hostable one.
 *
 * **Branching on a deployment variable, not on the model name.** `ports.ts` is
 * explicit that a port's `id` is identity and never dispatch, and the same
 * reasoning applies to the allowlist's pinned model: an operator running
 * `bge-m3` behind a gateway that reports some other name would silently get the
 * wrong client, and the failure would look like a bad embedding rather than a
 * bad configuration.
 *
 * `docs/13-threat-model.md` *Egress* rule 4 wants every outbound call to point
 * at something the operator could run themselves. voyage-3 is hosted only, so
 * that rule was aspirational while it was the only adapter; this is the branch
 * that makes it reachable, and `docs/14-roadmap.md` owns the benchmark that
 * decides whether the quality gap matters for deduplication.
 */
function embedderFor(
  env: NodeJS.ProcessEnv,
  egress: EgressEntry[],
  embedding: EgressEntry,
): Ports["embedder"] {
  const provider = env["STANDFAST_EMBEDDING_PROVIDER"] ?? "voyage";

  if (provider === "voyage") {
    return new VoyageEmbedder({
      apiKey: credential(env, "VOYAGE_API_KEY"),
      allowlist: egress,
      baseURL: embedding.origin,
      model: embedding.model,
    });
  }

  if (provider !== "self-hosted") {
    throw new Error(
      `STANDFAST_EMBEDDING_PROVIDER is "${provider}"; it is "voyage" or "self-hosted". A value nobody recognises must not fall back to a default that opens a socket the operator did not choose.`,
    );
  }

  // Deliberately not `credential()`, which throws when the variable is unset.
  // A model on the operator's own network may legitimately have no credential,
  // and sending a placeholder would turn "no key" into "bad key" against a
  // server that does check.
  const apiKey = env["STANDFAST_EMBEDDING_API_KEY"];

  return new BgeEmbedder({
    allowlist: egress,
    baseURL: embedding.origin,
    model: embedding.model,
    ...(apiKey ? { apiKey } : {}),
  });
}

/**
 * Resolves the three ports from configuration, and refuses anything the egress
 * allowlist does not admit.
 *
 * This is where the first outbound socket in this repository is opened, so it
 * is where the control lives. For every port that is not a deterministic fake:
 * the allowlist must name its purpose, the destination must match the entry's
 * origin exactly, the model must match the entry's pinned version exactly, and
 * the credential must be present. All four are checked **before the adapter is
 * constructed**, so a destination the allowlist does not name cannot be reached
 * even once.
 *
 * `docs/13-threat-model.md` (*Egress*, rule 1): a provider not on the list is
 * not called, and the failure is a start-up refusal rather than a fallback.
 */
export function resolvePorts(env = process.env): {
  ports: Ports;
  egress: EgressEntry[];
} {
  const configured = extractionPortIds(env);

  // Parsed before anything is constructed, so a malformed or forbidden entry
  // stops the process rather than being discovered when the first job runs.
  const egress = parseEgressAllowlist(env["STANDFAST_EGRESS_ALLOWLIST"]);

  const wanted = [
    ["extraction", configured.extractionModel],
    ["embedding", configured.embeddingModel],
    ["judge", configured.judgeModel],
  ] as const;

  const real = wanted.filter(([, model]) => !FAKE_PORT_IDS.has(model));
  const fake = wanted.filter(([, model]) => FAKE_PORT_IDS.has(model));

  // A build running entirely on fakes opens no socket, so an allowlist entry
  // here is permission granted and not exercised — which is how a permission
  // outlives the review that granted it.
  if (real.length === 0 && egress.length > 0) {
    throw new Error(
      `STANDFAST_EGRESS_ALLOWLIST names ${egress.length} destination(s), and every configured port is a deterministic fake. An allowlist entry with nothing behind it is permission nobody is using.`,
    );
  }

  // Mixed configurations are refused rather than half-served. A run with a real
  // extractor and a fake embedder would write atoms whose vectors mean nothing,
  // and `extractor_version` would record the pair as though it were a
  // deliberate configuration somebody could reproduce.
  if (real.length > 0 && fake.length > 0) {
    throw new Error(
      `mixed configuration: ${real.map(([p]) => p).join(", ")} name a provider while ${fake.map(([p]) => p).join(", ")} are deterministic fakes. Extraction runs entirely on fakes or entirely on providers.`,
    );
  }

  if (real.length === 0) {
    return { ports: fakePorts(), egress };
  }

  // The prompt is in this build; the version is in the configuration that the
  // API also reads to stamp job payloads. If they disagree, `extractor_version`
  // describes a prompt nobody ran — so a prompt edit that forgets to bump the
  // deployment's value fails here rather than mislabelling a corpus.
  if (configured.promptVersion !== PROMPT_VERSION) {
    throw new Error(
      `STANDFAST_EXTRACTION_PROMPT_VERSION is ${configured.promptVersion} and this build's prompts are ${PROMPT_VERSION}. extractor_version would name a prompt that never ran.`,
    );
  }

  // Each of these throws before its adapter exists. The adapters assert again
  // in their own constructors, and the repetition is deliberate: this loop is
  // what makes the refusal happen at boot with a message naming the
  // configuration, and the constructors are what make it impossible to reach a
  // destination from any other wiring.
  for (const [purpose, model] of real) {
    const entry = egress.find((e) => e.purpose === purpose);
    if (!entry) {
      throw new Error(
        `no egress allowlist entry for ${purpose}, which is configured for model ${model} (docs/13-threat-model.md, Egress, rule 1).`,
      );
    }
    assertEgressAllowed(egress, purpose, entry.origin, model);
  }

  const extraction = egress.find((e) => e.purpose === "extraction");
  const embedding = egress.find((e) => e.purpose === "embedding");
  const judge = egress.find((e) => e.purpose === "judge");
  if (!extraction || !embedding || !judge) {
    throw new Error(
      "extraction needs all three of extraction, embedding and judge on the allowlist.",
    );
  }

  const ports: Ports = {
    extractor: new AnthropicExtractor({
      apiKey: credential(env, "ANTHROPIC_API_KEY"),
      allowlist: egress,
      baseURL: extraction.origin,
      model: extraction.model,
    }),
    embedder: embedderFor(env, egress, embedding),
    judge: new AnthropicJudge({
      apiKey: credential(env, "ANTHROPIC_API_KEY"),
      allowlist: egress,
      baseURL: judge.origin,
      model: judge.model,
    }),
  };

  return { ports, egress };
}

async function main(): Promise<void> {
  // Before fetching a single job. A worker on a superuser connection is not a
  // degraded mode — it is a system with no tenant isolation that looks entirely
  // healthy, and it writes atoms into whichever org a payload names.
  await assertTenantIsolationApplies();

  const { ports, egress } = resolvePorts();
  const handle = makeSectionExtractHandler({ ports });
  const boss = await getBoss();

  await boss.work<SectionExtractJob>(
    SECTION_EXTRACT_QUEUE,
    { batchSize: 1 },
    async ([job]) => {
      if (!job) return;
      await handle(job.data, AbortSignal.timeout(120_000));
    },
  );

  process.stderr.write(
    `Standfast worker consuming ${SECTION_EXTRACT_QUEUE} (extractor ${ports.extractor.id}, embedder ${ports.embedder.id}, judge ${ports.judge.id})\n`,
  );
  // Rule 3: egress is disclosable. Printed at start-up so answering "what does
  // this deployment send, and to whom" never requires reading a source file.
  process.stderr.write(`${describeEgress(egress)}\n`);

  // Graceful, in that order. pg-boss's own stop returns jobs in flight to the
  // queue rather than losing them; closing the pool first would make that
  // return fail.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopBoss()
        .then(() => closePool())
        .then(() => process.exit(0));
    });
  }
}

if (process.argv[1]?.endsWith("main.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

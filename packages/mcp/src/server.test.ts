import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";

/**
 * The tool path, end to end and in memory.
 *
 * A real MCP client on `InMemoryTransport`, the real server, and a fetch that
 * answers with one API failure — so what these tests read is the exact surface
 * an agent reads, envelope and all, with no network anywhere. `hooks.test.ts`
 * covers the push channel; this file covers pull, which is the channel every
 * guarantee has to hold on (`docs/09-agent-contract.md`, *Pull versus push*).
 */

const PROJECT = "22222222-2222-4222-8222-222222222222";

async function connect(fetchImpl: typeof globalThis.fetch): Promise<Client> {
  const server = createServer({
    baseUrl: "http://standfast.invalid",
    apiKey: "sk-test",
    fetch: fetchImpl,
  });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

/** A fetch whose every answer is the API's real error shape: `{error: string}`. */
function apiAlways(status: number, message: string): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

type ToolResult = { isError?: boolean; content?: unknown };

function textOf(result: ToolResult): string {
  return ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** The two read-path tools, each with the smallest valid arguments. */
const READ_PATH_TOOLS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["context", { projectId: PROJECT }],
  ["search", { projectId: PROJECT, query: "which conventions govern this" }],
];

describe("what the agent sees when the API refuses", () => {
  /**
   * docs/09-agent-contract.md failure table, "Key missing, revoked or
   * expired". The verbatim string is the contract: `401 Invalid API key.` is
   * what tells an agent to stop calling and escalate to the human, so it is
   * pinned character for character rather than by status code alone.
   */
  it.each(READ_PATH_TOOLS)(
    "%s surfaces the verbatim 401 as a tool error",
    async (name, args) => {
      const client = await connect(apiAlways(401, "Invalid API key."));

      const result = (await client.callTool({
        name,
        arguments: { ...args },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("401 Invalid API key.");
    },
  );

  /**
   * Same table, "Project not found" — one body for both an unknown project and
   * another org's, so the answer cannot be used to probe which projects exist.
   * The agent's move is to ask which project, never to create one.
   */
  it.each(READ_PATH_TOOLS)(
    "%s surfaces the verbatim 404 as a tool error",
    async (name, args) => {
      const client = await connect(
        apiAlways(404, "Not found, or belongs to another org"),
      );

      const result = (await client.callTool({
        name,
        arguments: { ...args },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("404 Not found, or belongs to another org");
    },
  );
});

describe("the catalogue", () => {
  /**
   * Exactly six, and the number is a budget rather than a milestone: every
   * title and description is sent on every request of every session, and
   * `docs/08-mcp-server.md`'s cap of ten keeps four slots deliberately
   * unspent. And nothing in the catalogue creates a project or mints
   * knowledge — `propose` only stores provisional atoms, docs/09's failure
   * table ends "never create one", and ratification belongs to a human in the
   * CLI, not to any tool. A seventh tool, or a create/ratify verb, is a
   * product change and must fail here first.
   */
  it("lists exactly the six specified tools, none able to create or ratify", async () => {
    const neverFetch: typeof globalThis.fetch = async () => {
      throw new Error("listTools must not reach for the network");
    };
    const client = await connect(neverFetch);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "context",
      "propose",
      "read",
      "reconcile",
      "search",
      "status",
    ]);
    for (const name of names) {
      expect(name).not.toMatch(/create|ratify|approve|resolve|delete/i);
    }
  });
});

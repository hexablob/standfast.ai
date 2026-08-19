import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient, type StandfastClient } from "@standfast/sdk";
import { asToolError, asToolResult } from "./envelope.js";
import {
  CONTEXT_INPUT,
  DESCRIPTIONS,
  PROPOSE_INPUT,
  READ_INPUT,
  SEARCH_INPUT,
  STATUS_INPUT,
  TITLES,
} from "./tools.js";

export const SERVER_NAME = "standfast";

export type ServerOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
};

type ApiResult<T> = { data?: T; error?: unknown; response: Response };

/** Turns an API failure into a message an agent can act on. */
function unwrap<T>(result: ApiResult<T>): T {
  if (result.data === undefined) {
    const detail =
      (result.error as { error?: string } | undefined)?.error ??
      result.response.statusText;
    throw new Error(`${result.response.status} ${detail}`);
  }
  return result.data;
}

export function createServer(options: ServerOptions): McpServer {
  const client: StandfastClient = createClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const server = new McpServer({ name: SERVER_NAME, version: "0.0.0" });

  server.registerTool(
    "read",
    {
      title: TITLES.read,
      description: DESCRIPTIONS.read,
      inputSchema: READ_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ kind, id }) => {
      try {
        if (kind === "atom") {
          const atom = unwrap(
            await client.GET("/v1/atoms/{atomId}", {
              params: { path: { atomId: id } },
            }),
          );
          return asToolResult(atom);
        }
        if (kind === "section") {
          const section = unwrap(
            await client.GET("/v1/sections/{sectionId}", {
              params: { path: { sectionId: id } },
            }),
          );
          return asToolResult(section);
        }
        const document = unwrap(
          await client.GET("/v1/documents/{documentId}", {
            params: { path: { documentId: id } },
          }),
        );
        return asToolResult(document);
      } catch (error) {
        return asToolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  server.registerTool(
    "propose",
    {
      title: TITLES.propose,
      description: DESCRIPTIONS.propose,
      inputSchema: PROPOSE_INPUT,
      // Not read-only, not destructive: it only ever adds a provisional row.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const atom = unwrap(
          await client.POST("/v1/projects/{projectId}/atoms", {
            params: { path: { projectId: input.projectId } },
            body: {
              documentId: input.documentId,
              sectionId: input.sectionId,
              statement: input.statement,
              kind: input.kind,
              sourceQuote: input.sourceQuote,
              sourceSpan: input.sourceSpan,
            },
          }),
        );
        // Said back explicitly. An agent that assumes it has settled the
        // matter will not surface the pending decision to the human, and the
        // ratification queue is the bottleneck the product exists to move.
        return asToolResult({
          atom,
          note: "Stored as provisional. A human must ratify it before it becomes canonical.",
        });
      } catch (error) {
        return asToolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  server.registerTool(
    "status",
    {
      title: TITLES.status,
      description: DESCRIPTIONS.status,
      inputSchema: STATUS_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) => {
      try {
        const stats = unwrap(
          await client.GET("/v1/projects/{projectId}/atoms/stats", {
            params: { path: { projectId } },
          }),
        );

        // No cap, and nothing to report as truncated. The counts are computed
        // by the database over every atom in the project, so there is no
        // prefix, no scan limit, and no number here that describes a sample.
        // `docs/03-architecture.md` called the old local cap a cap in the wrong
        // layer; it was also wrong past its own limit, where it counted the
        // first five hundred atoms and called the result the project's totals.
        const { awaitingRatification, ...counts } = stats;
        return asToolResult({ projectId, counts, awaitingRatification });
      } catch (error) {
        return asToolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  /**
   * The cold-start killer, and the tool a `SessionStart` hook calls.
   *
   * Everything about the pack — selection, diversity, ordering, the budget —
   * happens behind the API, in `core`, over rows fetched by `db`. MMR needs the
   * vectors and the MCP server does not talk to Postgres
   * (`docs/03-architecture.md`), so this tool passes `budgetTokens` through and
   * returns what comes back untouched.
   *
   * **No envelope() call here, deliberately.** Capping a list locally is right
   * for `status`, whose API endpoint does not paginate. It would be wrong here:
   * the assembler already respected a budget the caller named, and slicing its
   * output afterwards would drop atoms it chose to keep while leaving
   * `budgetTokensUsed` describing a pack the agent never received.
   */
  server.registerTool(
    "context",
    {
      title: TITLES.context,
      description: DESCRIPTIONS.context,
      inputSchema: CONTEXT_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId, scope, query, paths, budgetTokens }) => {
      try {
        const pack = unwrap(
          await client.POST("/v1/projects/{projectId}/context", {
            params: { path: { projectId } },
            body: {
              scope,
              ...(query === undefined ? {} : { query }),
              paths,
              budgetTokens,
            },
          }),
        );
        return asToolResult(pack);
      } catch (error) {
        return asToolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: TITLES.search,
      description: DESCRIPTIONS.search,
      inputSchema: SEARCH_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId, query, mode, limit }) => {
      try {
        const found = unwrap(
          await client.POST("/v1/projects/{projectId}/search", {
            params: { path: { projectId } },
            body: { query, mode, limit },
          }),
        );
        return asToolResult(found);
      } catch (error) {
        return asToolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  return server;
}

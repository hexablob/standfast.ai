#!/usr/bin/env node
/**
 * The Standfast MCP server, over stdio.
 *
 * Configured in a client's MCP settings, for example:
 *
 *   {
 *     "mcpServers": {
 *       "standfast": {
 *         "command": "standfast-mcp",
 *         "env": {
 *           "STANDFAST_API_KEY": "sf_sk_…",
 *           "STANDFAST_BASE_URL": "https://api.standfast.ai"
 *         }
 *       }
 *     }
 *   }
 *
 * Diagnostics go to stderr. stdout carries the protocol, so a stray
 * console.log there corrupts the stream and the client sees a server that
 * fails to handshake for no visible reason.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env["STANDFAST_API_KEY"];
const baseUrl = process.env["STANDFAST_BASE_URL"] ?? "http://localhost:8080";

if (!apiKey) {
  process.stderr.write(
    "STANDFAST_API_KEY is not set. Create a key with `standfast login`, or see the README.\n",
  );
  process.exit(2);
}

const server = createServer({ apiKey, baseUrl });
await server.connect(new StdioServerTransport());

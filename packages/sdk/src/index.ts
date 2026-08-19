import createOpenApiClient from "openapi-fetch";
import type { components, paths } from "./schema.js";

/**
 * Typed client for the Standfast API.
 *
 * Apache-2.0, and that is load-bearing rather than incidental. The api, core,
 * db and worker packages are AGPL-3.0-only, so nothing that ships to a user's
 * machine — the CLI, the MCP server — may import them. This package exists so
 * those have an HTTP client to depend on without inheriting copyleft.
 *
 * `src/schema.d.ts` is generated from `infra/openapi/openapi.json`, the
 * committed artifact, not from a running server. The spec is the contract; CI
 * regenerates both and fails on a diff.
 */

export type Schema = components["schemas"];
export type Project = Schema["Project"];
export type Document = Schema["Document"];
export type DocumentSection = Schema["DocumentSection"];
export type Atom = Schema["Atom"];
export type CreateProject = Schema["CreateProject"];
export type CreateAtom = Schema["CreateAtom"];
export type PutDocument = Schema["PutDocument"];

export type ClientOptions = {
  /** e.g. `https://api.standfast.ai` or `http://localhost:8080` */
  baseUrl: string;
  /** A key from `standfast bootstrap`, sent as a bearer token. */
  apiKey: string;
  /** Injected by tests; defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch;
};

export type StandfastClient = ReturnType<typeof createClient>;

export function createClient(options: ClientOptions) {
  if (!options.apiKey) {
    // Failing here beats a 401 from ten call sites, none of which will say
    // which of the two possible things was missing.
    throw new Error("apiKey is required.");
  }

  return createOpenApiClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    headers: { Authorization: `Bearer ${options.apiKey}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export type { components, paths };

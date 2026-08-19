import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { type AuthVariables, requireApiKey } from "./middleware/auth.js";
import type { RetrievalPorts } from "./retrieval.js";
import { registerRoutes } from "./routes.js";

export type Env = { Variables: AuthVariables };

/**
 * The API surface. Every route is declared with `createRoute`, so the OpenAPI
 * document is a by-product of the same Zod schemas that validate the request
 * rather than a parallel artifact that drifts.
 */
export function createApp(
  // Injected rather than resolved here, so that a test can build an app with no
  // outbound calls at all — which is what every test does, and what makes the
  // read path runnable in CI with no network and no secrets.
  retrieval?: RetrievalPorts,
): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "Invalid request." }, 400);
      }
      return undefined;
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description:
      "An API key issued by `standfast bootstrap`, sent as a bearer token.",
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: "Internal error." }, 500);
  });

  // Unauthenticated: no tenant data, and a health check that requires a
  // credential is a health check nothing can call.
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use("/v1/*", requireApiKey);
  registerRoutes(app, undefined, retrieval);

  return app;
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Standfast API",
    version: "0.0.0",
    description: "A shared knowledge layer for coding agents.",
  },
} as const;

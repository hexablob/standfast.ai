import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { type AuthVariables, requireApiKey } from "./middleware/auth.js";
import type { RetrievalPorts } from "./retrieval.js";
import { registerRoutes } from "./routes.js";

export type Env = { Variables: AuthVariables };

/**
 * The byte ceiling on a request body, well above every character cap the Zod
 * schemas declare.
 *
 * The two are different guards and both are wanted. A `.max()` on a string
 * runs after `JSON.parse` has already materialised the whole payload, so it
 * bounds what may be *stored* but not what may be *read*; this bounds what is
 * read. Set an order of magnitude above `DOCUMENT_BODY_MAX_CHARS` on purpose:
 * a real client that overshoots the document cap should get the typed 400 that
 * names the limit it crossed, and should never learn this number exists. It is
 * the backstop for the payload that was never a document.
 */
const REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;

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
        // Zod's own wording, which names the constraint that failed — the
        // bound, the expected type, the permitted options — and never the
        // value that failed it. A boundary that refuses a request without
        // saying what it refused makes every caller guess, and a size cap
        // nobody can read is a size cap nobody can respect.
        //
        // The one thing Zod echoes back is a field *name*, on the `.strict()`
        // schemas, and only to the caller that just sent it. Field names are
        // not what invariant 3 protects; values are, and none reaches here.
        const issue = result.error.issues[0];
        return c.json({ error: issue?.message ?? "Invalid request." }, 400);
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

  // After the key check, not before it: an unauthenticated caller gets exactly
  // one answer on this surface, and a 413 handed out ahead of the 401 would be
  // a second one. Auth reads no body, so an oversized payload from a caller
  // with no key is still refused before anything parses it.
  //
  // On all of `/v1/*` rather than on the write routes alone. The routes that
  // carry no body never reach the counter — `bodyLimit` returns immediately
  // when there is none — so the narrower mount would buy nothing and would
  // have to be remembered every time a route is added.
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: REQUEST_BODY_MAX_BYTES,
      // The default response is plain text. Every other error on this API is
      // `{ "error": … }`, and one endpoint that answers differently is one
      // client branch nobody wrote.
      onError: (c) => c.json({ error: "Request body too large." }, 413),
    }),
  );

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

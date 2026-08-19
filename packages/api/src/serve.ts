/**
 * Runs the API as a process.
 *
 *   pnpm --filter @standfast/api run start
 *
 * Without this the package exports an app nobody can start, and the quickstart
 * in the README tells you to curl a port with nothing behind it.
 */
import { serve } from "@hono/node-server";
import {
  assertTenantIsolationApplies,
  assertVectorSearchSupported,
  closePool,
} from "@standfast/db";
import { createApp } from "./app.js";
import { describeApiEgress, resolveRetrievalPorts } from "./ports.js";

const port = Number(process.env["PORT"] ?? 8080);

// Before accepting a single request. Serving on a superuser connection is not
// a degraded mode — it is a system with no tenant isolation that looks
// entirely healthy.
await assertTenantIsolationApplies();

// Also before the first request, and for the same reason: the failure it
// guards against looks like health. An HNSW scan visits a bounded number of
// neighbours and the row-level security policy filters afterwards, so on a
// pgvector without iterative index scans a tenant holding a small share of a
// large table can have every returned row removed and be told there is nothing
// — with matching rows sitting in the table. `docs/06-retrieval.md` (*Tenancy,
// and the one place it interacts badly with ANN*) is why the extension version
// is asserted rather than assumed.
await assertVectorSearchSupported();

// Before the first request, and before the first socket. A destination the
// allowlist does not name cannot be reached even once, and a purpose this
// deployment may not configure stops the process here rather than failing a
// query later.
const { ports, egress } = resolveRetrievalPorts();

// Rule 3: egress is disclosable. Printed at start-up so that answering "what
// does this deployment send, and to whom" never requires reading a source
// file. A deployment with nothing configured prints that it sends nothing,
// which is the answer worth being able to give.
process.stderr.write(`${describeApiEgress(egress)}\n`);

const server = serve({ fetch: createApp(ports).fetch, port }, (info) => {
  process.stderr.write(
    `Standfast API listening on http://localhost:${info.port}\n`,
  );
});

// Close the pool on the way out. A dropped connection at shutdown surfaces as
// a confusing error in whatever was mid-request.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
  });
}

// Test-only helpers, published under `@standfast/db/testing` rather than from the
// package root.
//
// A separate entrypoint because these create roles, seed tenants and drop data.
// Reachable by the worker's integration suite, and never by anything a customer
// runs — an import of `@standfast/db` cannot get here by accident.

export { installQueue } from "../queue-install.js";
export {
  adminClient,
  adminUrl,
  appClient,
  ensureTestRole,
  type Seed,
  seed,
} from "./harness.js";

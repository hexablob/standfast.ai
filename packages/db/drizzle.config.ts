import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  dbCredentials: {
    // Migrations prefer the direct endpoint. On Neon the pooled endpoint does
    // not hold the session state some DDL and advisory locks need, and the
    // failure only shows up where the pooler is actually in front.
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"] ?? "",
  },
  // Refuse to apply a destructive statement without an explicit prompt.
  strict: true,
  verbose: true,
});

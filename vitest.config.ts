import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests run everywhere and need nothing. Anything that needs a
    // database lives in *.integration.test.ts and is excluded unless
    // DATABASE_URL is set, so a fresh clone can run `pnpm test` offline.
    include: ["packages/*/src/**/*.test.ts", "eval/src/**/*.test.ts"],
    exclude: process.env["DATABASE_URL"]
      ? ["**/node_modules/**", "**/dist/**"]
      : ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    passWithNoTests: true,

    // One file at a time. The integration suites share more than a database:
    // they share one pg-boss queue, and `section.extract` has a single name for
    // every tenant in it. A test that drains the queue drains another file's
    // jobs, and a test that counts what is on the queue counts them too — so in
    // parallel the extraction suites fail against each other, intermittently
    // and in whichever order the pool happened to pick.
    //
    // Scoping each assertion by project would fix the counting and not the
    // draining, because pg-boss hands out whatever is ready rather than
    // whatever a caller asked for. Serialising costs a few seconds on a suite
    // that takes under ten, and buys a class of flakiness never appearing in
    // CI at all.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "eval/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**"],
      reporter: ["text", "lcov"],
    },
  },
});

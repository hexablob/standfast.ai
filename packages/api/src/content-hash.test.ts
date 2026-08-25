import { readFile } from "node:fs/promises";
import { localContentHash } from "@standfast/cli";
import { contentHash } from "@standfast/core";
import { describe, expect, it } from "vitest";

/**
 * The cross-boundary hash pin (`docs/10-sync-daemon.md`, *The licence problem
 * in three lines of code*). `contentHash` lives in AGPL `packages/core`; the
 * Apache-2.0 CLI re-derives it rather than importing it. This test lives in
 * the AGPL half — which may depend on both — and holds the two
 * implementations to one answer over a committed vector chosen to expose any
 * future normalisation: CRLF line endings, no trailing newline, a character
 * outside the BMP. The `.gitattributes` in this package (`*.vector -text`)
 * keeps git from ever normalising the CRLFs out of the fixture.
 *
 * If this test fails, the definition moved. Move it in one place and re-pin;
 * do not paper over the drift on either side.
 */
const PINNED =
  "5ed2663556abc3a3eab3576e44b90ecb8d4444aca734e241d7f7a552b70b31ef";

describe("content hash, across the licence boundary", () => {
  it("server and CLI agree over the committed vector and match the pin", async () => {
    const text = await readFile(
      new URL("./content-hash.vector", import.meta.url),
      "utf8",
    );

    // The fixture itself first: if git or an editor normalised it, fail on
    // the property, not on an opaque hex mismatch.
    expect(text).toContain("\r\n");
    expect(text.endsWith("\n")).toBe(false);
    expect(/[\u{10000}-\u{10FFFF}]/u.test(text)).toBe(true);

    expect(contentHash(text)).toBe(PINNED);
    expect(localContentHash(text)).toBe(PINNED);
  });
});

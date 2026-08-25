import { describe, expect, it } from "vitest";
import { parseMinFindings } from "./edits.js";

describe("parseMinFindings", () => {
  it("is unset when the variable is absent or empty", () => {
    // No default. The minimum is a human decision computed from the 5% bar and
    // the tolerable interval width; a harness that defaulted it chose it.
    expect(parseMinFindings(undefined)).toEqual({ kind: "unset" });
    expect(parseMinFindings("")).toEqual({ kind: "unset" });
  });

  it("refuses anything but a positive integer", () => {
    for (const raw of ["0", "-3", "12.5", "twenty", "1e3"]) {
      expect(parseMinFindings(raw)).toEqual({ kind: "invalid", raw });
    }
  });

  it("accepts a positive integer", () => {
    expect(parseMinFindings("40")).toEqual({ kind: "set", value: 40 });
  });
});

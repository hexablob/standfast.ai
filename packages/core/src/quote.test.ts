import { describe, expect, it } from "vitest";
import { locateQuote, quoteAt } from "./quote.js";

describe("locateQuote", () => {
  it("returns null when the quote is not there", () => {
    // Dropped, not repaired. A candidate whose quote is absent is the
    // hallucination this mechanism exists to catch, and there is no nearest
    // passage it should have meant.
    expect(locateQuote("Ship on Fridays.", "Ship on Tuesdays.")).toBeNull();
  });

  it("takes the first occurrence when the quote repeats", () => {
    const body = "yes. no. yes.";
    expect(locateQuote(body, "yes.")).toEqual({ start: 0, end: 4 });
  });

  it("normalises nothing", () => {
    const body = "  Ship on Fridays.  ";
    // A trimmed match would land at 2 and the stored span would then name
    // "Ship on Fridays." while the quote carries its spaces, which is exactly
    // the disagreement the database trigger refuses.
    expect(locateQuote(body, "Ship on Fridays.")).toEqual({
      start: 2,
      end: 18,
    });
    expect(locateQuote(body, "ship on fridays.")).toBeNull();
    expect(locateQuote("a\tb", "a b")).toBeNull();
  });

  it("counts code points, not UTF-16 code units", () => {
    // The whole reason this function exists. "🚢" is one code point and two
    // UTF-16 units, so indexOf reports 8 where Postgres substring wants 7.
    const body = "Ship it 🚢 on Fridays.";
    const span = locateQuote(body, "on Fridays.");

    expect(body.indexOf("on Fridays.")).toBe(11);
    expect(span).toEqual({ start: 10, end: 21 });
  });

  it("counts a quote that itself contains astral characters", () => {
    const body = "prefix 👨‍👩‍👧‍👦 family 🚢 tail";
    const quote = "👨‍👩‍👧‍👦 family";
    const span = locateQuote(body, quote);

    expect(span).not.toBeNull();
    expect(span && span.end - span.start).toBe([...quote].length);
  });

  it("round-trips with quoteAt, which is what the trigger compares", () => {
    for (const body of [
      "Ship on Fridays.",
      "🚢 Ship on Fridays.",
      "héllo wörld — ship\non Fridays.",
      "𝕬𝖇𝖈 and then some text",
    ]) {
      const quote = [...body].slice(2, 9).join("");
      const span = locateQuote(body, quote);
      expect(span).not.toBeNull();
      expect(span && quoteAt(body, span)).toBe(quote);
    }
  });

  it("finds an empty quote at the start, and says so", () => {
    // The database refuses this separately — atoms_source_quote_not_blank and
    // atoms_source_span_not_empty — so the answer here only has to be honest,
    // not defensive.
    expect(locateQuote("anything", "")).toEqual({ start: 0, end: 0 });
  });
});

describe("quoteAt", () => {
  it("refuses a span that runs past the body", () => {
    expect(quoteAt("short", { start: 0, end: 99 })).toBeNull();
    expect(quoteAt("short", { start: -1, end: 2 })).toBeNull();
    expect(quoteAt("short", { start: 3, end: 1 })).toBeNull();
  });

  it("slices in code points", () => {
    expect(quoteAt("🚢🚢abc", { start: 2, end: 5 })).toBe("abc");
  });
});

import { describe, expect, it } from "vitest";
import { contextTokensFromUsage } from "./index";

describe("contextTokensFromUsage", () => {
  it("returns input when there is no cache", () => {
    expect(
      contextTokensFromUsage({
        input: 14000,
        output: 100,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
    ).toBe(14000);
  });

  it("adds cached prompt tokens so cached sessions aren't undercounted", () => {
    // The non-cached delta is tiny but the real context is ~232k.
    expect(contextTokensFromUsage({ input: 760, cache: { read: 231424, write: 0 } })).toBe(232184);
  });

  it("includes newly-written cache tokens", () => {
    expect(contextTokensFromUsage({ input: 1000, cache: { read: 5000, write: 2000 } })).toBe(8000);
  });

  it("tolerates missing optional fields", () => {
    expect(contextTokensFromUsage({ input: 500 })).toBe(500);
    expect(contextTokensFromUsage({ input: 500, cache: { read: 250 } })).toBe(750);
  });
});

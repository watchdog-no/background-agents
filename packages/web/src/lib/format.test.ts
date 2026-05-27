import { describe, it, expect } from "vitest";
import { formatTokens } from "./format";

describe("formatTokens", () => {
  it("shows raw counts below 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(800)).toBe("800");
    expect(formatTokens(999)).toBe("999");
  });

  it("rounds to thousands between 1k and 1M", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(14_059)).toBe("14k");
    expect(formatTokens(232_441)).toBe("232k");
    expect(formatTokens(999_499)).toBe("999k");
  });

  it("rolls over to M instead of rendering 1000k", () => {
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_050_000)).toBe("1.1M");
  });
});

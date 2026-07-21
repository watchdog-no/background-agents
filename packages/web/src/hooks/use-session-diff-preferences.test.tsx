// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDiffPreferences } from "./use-session-diff-preferences";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", createMemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("useSessionDiffPreferences", () => {
  it("wraps lines by default when the user has not chosen a preference", () => {
    const { result } = renderHook(() => useSessionDiffPreferences());

    expect(result.current.wrap).toBe(true);
  });

  it("restores and persists an explicit no-wrap preference", async () => {
    localStorage.setItem("session-changes.wrap", "false");
    const { result } = renderHook(() => useSessionDiffPreferences());

    await waitFor(() => expect(result.current.wrap).toBe(false));
    act(() => result.current.setWrap(true));

    expect(localStorage.getItem("session-changes.wrap")).toBe("true");
  });
});

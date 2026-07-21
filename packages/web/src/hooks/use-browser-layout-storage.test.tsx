// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useDefaultLayout } from "react-resizable-panels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserLayoutStorage } from "./use-browser-layout-storage";

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

function LayoutProbe() {
  const storage = useBrowserLayoutStorage();
  useDefaultLayout({ id: "ssr-layout-probe", panelIds: ["main"], storage });
  return null;
}

describe("useBrowserLayoutStorage", () => {
  beforeEach(() => vi.stubGlobal("localStorage", createMemoryStorage()));

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("provides explicit storage when a panel layout renders on the server", () => {
    expect(() => renderToString(<LayoutProbe />)).not.toThrow();
  });

  it("persists layouts after hydration", async () => {
    const { result } = renderHook(() => useBrowserLayoutStorage());

    await waitFor(() => {
      result.current.setItem("layout", "saved");
      expect(result.current.getItem("layout")).toBe("saved");
    });
    expect(window.localStorage.getItem("layout")).toBe("saved");
  });

  it("fails open when browser storage operations are restricted", async () => {
    const restrictedStorage = {
      getItem: vi.fn(() => {
        throw new DOMException("Storage denied", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("Storage denied", "SecurityError");
      }),
    } as unknown as Storage;
    vi.stubGlobal("localStorage", restrictedStorage);

    const { result } = renderHook(() => useBrowserLayoutStorage());

    await waitFor(() => expect(() => result.current.getItem("layout")).not.toThrow());
    expect(result.current.getItem("layout")).toBeNull();
    expect(() => result.current.setItem("layout", "saved")).not.toThrow();
  });

  it("fails open when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);

    const { result } = renderHook(() => useBrowserLayoutStorage());

    expect(result.current.getItem("layout")).toBeNull();
  });
});

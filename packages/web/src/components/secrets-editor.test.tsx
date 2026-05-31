// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { SecretsEditor } from "./secrets-editor";

expect.extend(matchers);

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

const GLOBAL_KEY = "/api/secrets";
const REPO_KEY = "/api/repos/acme/app/secrets";

function secret(key: string, value: string | null, decryptionFailed = false) {
  return { key, value, createdAt: 1, updatedAt: 1, decryptionFailed };
}

function renderWithSWR(ui: ReactNode, fallbackData: Record<string, unknown>) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: fallbackData,
        dedupingInterval: Infinity,
        revalidateIfStale: false,
        revalidateOnFocus: false,
        revalidateOnMount: false,
        revalidateOnReconnect: false,
      }}
    >
      {ui}
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SecretsEditor", () => {
  it("renders saved secret values masked by default and revealable", async () => {
    renderWithSWR(<SecretsEditor scope="global" />, {
      [GLOBAL_KEY]: { secrets: [secret("API_KEY", "super-secret")] },
    });

    const input = await screen.findByLabelText("Value for API_KEY");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("super-secret");

    await userEvent.click(screen.getByRole("button", { name: "Show value" }));

    expect(input).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Hide value" }));

    expect(input).toHaveAttribute("type", "password");
  });

  it("reveals inherited global secret values in repo scope", async () => {
    renderWithSWR(<SecretsEditor scope="repo" owner="acme" name="app" />, {
      [REPO_KEY]: {
        secrets: [],
        globalSecrets: [secret("GLOBAL_KEY", "global-secret")],
      },
    });

    const input = await screen.findByLabelText("Inherited global value for GLOBAL_KEY");
    expect(input).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("button", { name: "Show value" }));

    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("global-secret");
  });

  it("does not save unchanged loaded secrets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderWithSWR(<SecretsEditor scope="global" />, {
      [GLOBAL_KEY]: { secrets: [secret("API_KEY", "super-secret")] },
    });

    await userEvent.click(screen.getByText("Save secrets"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves only changed loaded secrets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "updated" })));
    vi.stubGlobal("fetch", fetchMock);

    renderWithSWR(<SecretsEditor scope="global" />, {
      [GLOBAL_KEY]: {
        secrets: [secret("API_KEY", "old-secret"), secret("UNCHANGED", "same-secret")],
      },
    });

    const input = await screen.findByLabelText("Value for API_KEY");
    await userEvent.clear(input);
    await userEvent.type(input, "new-secret");
    await userEvent.click(screen.getByText("Save secrets"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      secrets: { API_KEY: "new-secret" },
    });
  });

  it("allows an unchanged blank existing secret while saving another edit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "updated" })));
    vi.stubGlobal("fetch", fetchMock);

    renderWithSWR(<SecretsEditor scope="global" />, {
      [GLOBAL_KEY]: {
        secrets: [secret("EMPTY_VALUE", ""), secret("API_KEY", "old-secret")],
      },
    });

    const input = await screen.findByLabelText("Value for API_KEY");
    await userEvent.clear(input);
    await userEvent.type(input, "new-secret");
    await userEvent.click(screen.getByText("Save secrets"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      secrets: { API_KEY: "new-secret" },
    });
  });

  it("allows a decrypt-failed existing secret while saving another edit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "updated" })));
    vi.stubGlobal("fetch", fetchMock);

    renderWithSWR(<SecretsEditor scope="global" />, {
      [GLOBAL_KEY]: {
        secrets: [secret("BROKEN", null, true), secret("API_KEY", "old-secret")],
      },
    });

    expect(
      await screen.findByText("Value could not be decrypted. Enter a new value and save.")
    ).toBeInTheDocument();

    const input = await screen.findByLabelText("Value for API_KEY");
    await userEvent.clear(input);
    await userEvent.type(input, "new-secret");
    await userEvent.click(screen.getByText("Save secrets"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      secrets: { API_KEY: "new-secret" },
    });
  });
});

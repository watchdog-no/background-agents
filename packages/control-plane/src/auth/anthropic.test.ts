import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshAnthropicToken, AnthropicTokenRefreshError } from "./anthropic";
import type { AnthropicTokenResponse } from "./anthropic";

describe("anthropic", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("refreshAnthropicToken", () => {
    it("returns tokens on success", async () => {
      const mockTokens: AnthropicTokenResponse = {
        access_token: "acc_123",
        refresh_token: "rt_new",
        expires_in: 3600,
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokens),
      } as unknown as Response);

      const result = await refreshAnthropicToken("rt_old");

      expect(result).toEqual(mockTokens);
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("https://console.anthropic.com/v1/oauth/token");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(init.body).toContain("grant_type=refresh_token");
      expect(init.body).toContain("refresh_token=rt_old");
      expect(init.body).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    });

    it("throws AnthropicTokenRefreshError on 401 with status and body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"invalid_grant"}'),
      } as unknown as Response);

      const err = await refreshAnthropicToken("rt_expired").catch((e) => e);
      expect(err).toBeInstanceOf(AnthropicTokenRefreshError);
      expect(err.status).toBe(401);
      expect(err.body).toBe('{"error":"invalid_grant"}');
    });

    it("throws AnthropicTokenRefreshError on 500", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as unknown as Response);

      await expect(refreshAnthropicToken("rt_any")).rejects.toThrow(AnthropicTokenRefreshError);
    });

    it("propagates network errors", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      await expect(refreshAnthropicToken("rt_any")).rejects.toThrow("fetch failed");
    });
  });
});

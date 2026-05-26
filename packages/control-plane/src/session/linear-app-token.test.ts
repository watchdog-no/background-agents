import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { injectLinearAppToken } from "./linear-app-token";

function makeLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  (logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);
  return logger;
}

function makeEnv(fetchImpl?: Fetcher["fetch"], secret = "internal-secret"): Env {
  return {
    INTERNAL_CALLBACK_SECRET: secret,
    LINEAR_BOT: fetchImpl ? ({ fetch: fetchImpl } as unknown as Fetcher) : undefined,
  } as unknown as Env;
}

describe("injectLinearAppToken", () => {
  it("skips when the linear-bot binding is missing", async () => {
    const envVars: Record<string, string> = {};
    const log = makeLogger();

    await injectLinearAppToken(makeEnv(undefined), envVars, log);

    expect(envVars).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("skips when internal auth is not configured", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ accessToken: "tok" })));
    const envVars: Record<string, string> = {};
    const log = makeLogger();

    await injectLinearAppToken(makeEnv(fetch, ""), envVars, log);

    expect(fetch).not.toHaveBeenCalled();
    expect(envVars).toEqual({});
  });

  it("preserves a user-provided LINEAR_API_KEY", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ accessToken: "app-token" })));
    const envVars = { LINEAR_API_KEY: "user-token" };
    const log = makeLogger();

    await injectLinearAppToken(makeEnv(fetch), envVars, log);

    expect(fetch).not.toHaveBeenCalled();
    expect(envVars.LINEAR_API_KEY).toBe("user-token");
  });

  it("injects a successful app token with Bearer prefix", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
      return new Response(JSON.stringify({ accessToken: "app-token" }), { status: 200 });
    });
    const envVars: Record<string, string> = {};
    const log = makeLogger();

    await injectLinearAppToken(makeEnv(fetch), envVars, log);

    expect(envVars.LINEAR_API_KEY).toBe("Bearer app-token");
    expect(log.info).toHaveBeenCalledWith("Injected Linear app-actor token into sandbox env");
  });

  it("logs 404 token responses at debug", async () => {
    const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
    const envVars: Record<string, string> = {};
    const log = makeLogger();

    await injectLinearAppToken(makeEnv(fetch), envVars, log);

    expect(envVars).toEqual({});
    expect(log.debug).toHaveBeenCalledWith("Linear app token unavailable, skipping injection", {
      status: 404,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([401, 500])("logs %s token responses at warn", async (status) => {
    const fetch = vi.fn(async () => new Response("failure", { status }));
    const envVars: Record<string, string> = {};
    const log = makeLogger();

    await injectLinearAppToken(makeEnv(fetch), envVars, log);

    expect(envVars).toEqual({});
    expect(log.warn).toHaveBeenCalledWith(
      "Linear app token fetch returned non-OK response, skipping injection",
      { status }
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("logs fetch failures at warn without throwing", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const envVars: Record<string, string> = {};
    const log = makeLogger();

    await expect(injectLinearAppToken(makeEnv(fetch), envVars, log)).resolves.toBeUndefined();

    expect(envVars).toEqual({});
    expect(log.warn).toHaveBeenCalledWith("Failed to fetch Linear app token", {
      error: expect.any(Error),
    });
  });
});

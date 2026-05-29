import { refreshAnthropicToken, AnthropicTokenRefreshError } from "../auth/anthropic";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const ANTHROPIC_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

type AnthropicTokenState =
  | { type: "cached"; accessToken: string; expiresIn: number }
  | { type: "refresh"; refreshToken: string; source: "repo" | "global"; repoId: number };

export type AnthropicTokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number }
  | { ok: false; status: number; error: string };

export class AnthropicTokenRefreshService {
  constructor(
    private readonly db: Env["DB"],
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {}

  async refresh(session: SessionRow): Promise<AnthropicTokenRefreshResult> {
    const readTokenState = () => this.readTokenState(session);

    let tokenState: AnthropicTokenState | null;
    try {
      tokenState = await readTokenState();
    } catch (e) {
      this.log.error("Failed to read Anthropic token state from secrets", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }

    if (!tokenState) {
      return { ok: false, status: 404, error: "ANTHROPIC_OAUTH_REFRESH_TOKEN not configured" };
    }

    if (tokenState.type === "cached") {
      return {
        ok: true,
        accessToken: tokenState.accessToken,
        expiresIn: tokenState.expiresIn,
      };
    }

    try {
      return await this.attemptRefresh(tokenState, session);
    } catch (e) {
      if (e instanceof AnthropicTokenRefreshError && e.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState, session);
      }

      this.log.error("Anthropic token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "Anthropic token refresh failed" };
    }
  }

  private getTokenStateFromSecrets(
    secrets: Record<string, string>,
    source: "repo" | "global",
    repoId: number
  ): AnthropicTokenState | null {
    if (!secrets.ANTHROPIC_OAUTH_REFRESH_TOKEN) {
      return null;
    }

    const cachedToken = secrets.ANTHROPIC_OAUTH_ACCESS_TOKEN;
    const expiresAt = parseInt(secrets.ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();

    if (cachedToken && expiresAt - now > ANTHROPIC_TOKEN_REFRESH_BUFFER_MS) {
      return {
        type: "cached",
        accessToken: cachedToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
      };
    }

    return {
      type: "refresh",
      refreshToken: secrets.ANTHROPIC_OAUTH_REFRESH_TOKEN,
      source,
      repoId,
    };
  }

  private async readTokenState(session: SessionRow): Promise<AnthropicTokenState | null> {
    const repoId = await this.ensureRepoId(session);

    const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
    const repoSecrets = await repoStore.getDecryptedSecrets(repoId);
    const repoState = this.getTokenStateFromSecrets(repoSecrets, "repo", repoId);
    if (repoState) {
      return repoState;
    }

    const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();
    return this.getTokenStateFromSecrets(globalSecrets, "global", repoId);
  }

  private async attemptRefresh(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    session: SessionRow
  ): Promise<AnthropicTokenRefreshResult> {
    const tokens = await refreshAnthropicToken(tokenState.refreshToken);
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

    try {
      const secretsToWrite: Record<string, string> = {
        ANTHROPIC_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
        ANTHROPIC_OAUTH_ACCESS_TOKEN: tokens.access_token,
        ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
      };

      if (tokenState.source === "repo") {
        const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
        await repoStore.setSecrets(
          tokenState.repoId,
          session.repo_owner,
          session.repo_name,
          secretsToWrite
        );
      } else {
        const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
        await globalStore.setSecrets(secretsToWrite);
      }

      this.log.info("Anthropic tokens rotated and cached", {
        source: tokenState.source,
      });
    } catch (e) {
      this.log.error("Failed to store rotated Anthropic tokens", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return {
      ok: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
    };
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    readTokenState: () => Promise<AnthropicTokenState | null>,
    session: SessionRow
  ): Promise<AnthropicTokenRefreshResult> {
    this.log.warn("Anthropic refresh got 401, checking for concurrent rotation", {
      source: tokenState.source,
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const reread = await readTokenState();

      if (reread?.type === "cached") {
        this.log.info("Using cached access token from concurrent rotation");
        return {
          ok: true,
          accessToken: reread.accessToken,
          expiresIn: reread.expiresIn,
        };
      }

      if (reread?.type === "refresh" && reread.refreshToken !== tokenState.refreshToken) {
        this.log.info("Detected concurrent token rotation, retrying");
        return this.attemptRefresh(reread, session);
      }
    } catch (retryErr) {
      this.log.error("Retry after 401 also failed", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return { ok: false, status: 401, error: "Anthropic token refresh failed: unauthorized" };
  }
}

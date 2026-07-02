import {
  refreshAnthropicToken,
  AnthropicTokenRefreshError,
  type AnthropicOAuthConfig,
} from "../auth/anthropic";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const ANTHROPIC_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS = 3;
const ROTATED_REFRESH_TOKEN_PERSIST_RETRY_DELAY_MS = 100;

type AnthropicTokenState =
  | { type: "cached"; accessToken: string; expiresIn: number }
  | { type: "refresh"; refreshToken: string; source: "repo" | "global"; repoId: number | null };

/**
 * Identifies the repo a rotated secret should be written back to. Null for the
 * global-only path (e.g. the repo classifier), which has no session/repo.
 */
type RepoWriteContext = { repoOwner: string; repoName: string };

export type AnthropicTokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number }
  | { ok: false; status: number; error: string };

export class AnthropicTokenRefreshService {
  constructor(
    private readonly db: Env["DB"],
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger,
    private readonly oauthConfig?: AnthropicOAuthConfig
  ) {}

  /**
   * Refresh using a session's repo-scoped secrets, falling back to global.
   */
  async refresh(session: SessionRow): Promise<AnthropicTokenRefreshResult> {
    const repoContext =
      session.repo_owner && session.repo_name
        ? { repoOwner: session.repo_owner, repoName: session.repo_name }
        : null;
    return this.refreshFromState(() => this.readTokenState(session), repoContext);
  }

  /**
   * Refresh using only the deployment-wide global secrets — no session/repo.
   * Used by callers that run before a session exists (e.g. the repo classifier).
   */
  async refreshGlobal(): Promise<AnthropicTokenRefreshResult> {
    return this.refreshFromState(() => this.readGlobalTokenState(), null);
  }

  private async refreshFromState(
    readTokenState: () => Promise<AnthropicTokenState | null>,
    repoContext: RepoWriteContext | null
  ): Promise<AnthropicTokenRefreshResult> {
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
      return await this.attemptRefresh(tokenState, repoContext);
    } catch (e) {
      if (e instanceof AnthropicTokenRefreshError && this.isConcurrentRotationError(e)) {
        return this.handleConcurrentRotationRefresh(tokenState, readTokenState, repoContext, e);
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
    repoId: number | null
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
    let repoId: number | null = null;
    if (session.repo_owner && session.repo_name) {
      repoId = await this.ensureRepoId(session);

      const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
      const repoSecrets = await repoStore.getDecryptedSecrets(repoId);
      const repoState = this.getTokenStateFromSecrets(repoSecrets, "repo", repoId);
      if (repoState) {
        return repoState;
      }
    }

    const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();
    return this.getTokenStateFromSecrets(globalSecrets, "global", repoId);
  }

  private async readGlobalTokenState(): Promise<AnthropicTokenState | null> {
    const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();
    return this.getTokenStateFromSecrets(globalSecrets, "global", null);
  }

  private async attemptRefresh(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    repoContext: RepoWriteContext | null
  ): Promise<AnthropicTokenRefreshResult> {
    const tokens = this.oauthConfig
      ? await refreshAnthropicToken(tokenState.refreshToken, this.oauthConfig)
      : await refreshAnthropicToken(tokenState.refreshToken);
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
    let refreshTokenPersisted = false;

    try {
      await this.writeRotatedRefreshToken(tokenState, repoContext, tokens.refresh_token);
      refreshTokenPersisted = true;

      this.log.info("Anthropic refresh token rotated", {
        source: tokenState.source,
        repo_id: tokenState.repoId,
      });
    } catch (e) {
      this.log.error("ANTHROPIC_OAUTH_REFRESH_TOKEN_PERSIST_FAILED_AFTER_ROTATION", {
        source: tokenState.source,
        repo_id: tokenState.repoId,
        credential_state: "previous_refresh_token_invalid",
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (refreshTokenPersisted) {
      try {
        await this.writeTokenSecrets(tokenState, repoContext, {
          ANTHROPIC_OAUTH_ACCESS_TOKEN: tokens.access_token,
          ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
        });

        this.log.info("Anthropic access token cached", {
          source: tokenState.source,
          repo_id: tokenState.repoId,
        });
      } catch (e) {
        this.log.warn("Failed to cache Anthropic access token after refresh", {
          source: tokenState.source,
          repo_id: tokenState.repoId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return {
      ok: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
    };
  }

  private isConcurrentRotationError(error: AnthropicTokenRefreshError): boolean {
    if (error.status === 401) {
      return true;
    }

    if (error.status !== 400) {
      return false;
    }

    try {
      const body = JSON.parse(error.body) as { error?: unknown };
      return body.error === "invalid_grant";
    } catch {
      return error.body.includes("invalid_grant");
    }
  }

  private async writeTokenSecrets(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    repoContext: RepoWriteContext | null,
    secrets: Record<string, string>
  ): Promise<void> {
    if (tokenState.source === "repo") {
      if (tokenState.repoId === null || !repoContext) {
        throw new Error("Repository-scoped Anthropic tokens require a repository context");
      }
      const repoStore = new RepoSecretsStore(this.db, this.encryptionKey);
      await repoStore.setSecrets(
        tokenState.repoId,
        repoContext.repoOwner,
        repoContext.repoName,
        secrets
      );
    } else {
      const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
      await globalStore.setSecrets(secrets);
    }
  }

  private async writeRotatedRefreshToken(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    repoContext: RepoWriteContext | null,
    refreshToken: string
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS; attempt++) {
      try {
        await this.writeTokenSecrets(tokenState, repoContext, {
          ANTHROPIC_OAUTH_REFRESH_TOKEN: refreshToken,
        });
        return;
      } catch (e) {
        lastError = e;
        if (attempt < ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, ROTATED_REFRESH_TOKEN_PERSIST_RETRY_DELAY_MS * attempt)
          );
        }
      }
    }

    throw lastError;
  }

  private async handleConcurrentRotationRefresh(
    tokenState: Extract<AnthropicTokenState, { type: "refresh" }>,
    readTokenState: () => Promise<AnthropicTokenState | null>,
    repoContext: RepoWriteContext | null,
    error: AnthropicTokenRefreshError
  ): Promise<AnthropicTokenRefreshResult> {
    this.log.warn("Anthropic refresh failed, checking for concurrent rotation", {
      status: error.status,
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
        return this.attemptRefresh(reread, repoContext);
      }

      this.log.error("Anthropic refresh token rejected and no newer token was found", {
        status: error.status,
        source: tokenState.source,
        repo_id: tokenState.repoId,
        action: "re-run Anthropic OAuth login",
      });
    } catch (retryErr) {
      this.log.error("Retry after Anthropic refresh failure also failed", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return { ok: false, status: error.status, error: "Anthropic token refresh failed" };
  }
}

import {
  refreshOpenAIToken,
  extractOpenAIAccountId,
  OpenAITokenRefreshError,
} from "../auth/openai";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS = 3;
const ROTATED_REFRESH_TOKEN_PERSIST_RETRY_DELAY_MS = 100;

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | { type: "refresh"; refreshToken: string; source: "repo" | "global"; repoId: number | null };

/**
 * Identifies the repo a rotated secret should be written back to. Null for the
 * global-only path (e.g. the repo classifier), which has no session/repo.
 */
type RepoWriteContext = { repoOwner: string; repoName: string };

export type OpenAITokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number; accountId?: string }
  | { ok: false; status: number; error: string };

export class OpenAITokenRefreshService {
  constructor(
    private readonly db: Env["DB"],
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {}

  /**
   * Refresh using a session's repo-scoped secrets, falling back to global.
   */
  async refresh(session: SessionRow): Promise<OpenAITokenRefreshResult> {
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
  async refreshGlobal(): Promise<OpenAITokenRefreshResult> {
    return this.refreshFromState(() => this.readGlobalTokenState(), null);
  }

  private async refreshFromState(
    readTokenState: () => Promise<OpenAITokenState | null>,
    repoContext: RepoWriteContext | null
  ): Promise<OpenAITokenRefreshResult> {
    let tokenState: OpenAITokenState | null;
    try {
      tokenState = await readTokenState();
    } catch (e) {
      this.log.error("Failed to read OpenAI token state from secrets", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }

    if (!tokenState) {
      return { ok: false, status: 404, error: "OPENAI_OAUTH_REFRESH_TOKEN not configured" };
    }

    if (tokenState.type === "cached") {
      return {
        ok: true,
        accessToken: tokenState.accessToken,
        expiresIn: tokenState.expiresIn,
        accountId: tokenState.accountId,
      };
    }

    try {
      return await this.attemptRefresh(tokenState, repoContext);
    } catch (e) {
      if (e instanceof OpenAITokenRefreshError && e.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState, repoContext);
      }

      this.log.error("OpenAI token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "OpenAI token refresh failed" };
    }
  }

  private getTokenStateFromSecrets(
    secrets: Record<string, string>,
    source: "repo" | "global",
    repoId: number | null
  ): OpenAITokenState | null {
    if (!secrets.OPENAI_OAUTH_REFRESH_TOKEN) {
      return null;
    }

    const cachedToken = secrets.OPENAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = parseInt(secrets.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();

    if (cachedToken && expiresAt - now > OPENAI_TOKEN_REFRESH_BUFFER_MS) {
      return {
        type: "cached",
        accessToken: cachedToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
        accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
      };
    }

    return {
      type: "refresh",
      refreshToken: secrets.OPENAI_OAUTH_REFRESH_TOKEN,
      source,
      repoId,
    };
  }

  private async readTokenState(session: SessionRow): Promise<OpenAITokenState | null> {
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

  private async readGlobalTokenState(): Promise<OpenAITokenState | null> {
    const globalStore = new GlobalSecretsStore(this.db, this.encryptionKey);
    const globalSecrets = await globalStore.getDecryptedSecrets();
    return this.getTokenStateFromSecrets(globalSecrets, "global", null);
  }

  private async attemptRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    repoContext: RepoWriteContext | null
  ): Promise<OpenAITokenRefreshResult> {
    const tokens = await refreshOpenAIToken(tokenState.refreshToken);
    const accountId = extractOpenAIAccountId(tokens);
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
    let refreshTokenPersisted = false;

    try {
      await this.writeRotatedRefreshToken(tokenState, repoContext, tokens.refresh_token);
      refreshTokenPersisted = true;

      this.log.info("OpenAI refresh token rotated", {
        source: tokenState.source,
        repo_id: tokenState.repoId,
      });
    } catch (e) {
      this.log.error("OPENAI_OAUTH_REFRESH_TOKEN_PERSIST_FAILED_AFTER_ROTATION", {
        source: tokenState.source,
        repo_id: tokenState.repoId,
        credential_state: "previous_refresh_token_invalid",
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (refreshTokenPersisted) {
      try {
        const cacheSecrets: Record<string, string> = {
          OPENAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
          OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
        };

        if (accountId) {
          cacheSecrets.OPENAI_OAUTH_ACCOUNT_ID = accountId;
        }

        await this.writeTokenSecrets(tokenState, repoContext, cacheSecrets);

        this.log.info("OpenAI access token cached", {
          source: tokenState.source,
          repo_id: tokenState.repoId,
          has_account_id: !!accountId,
        });
      } catch (e) {
        this.log.warn("Failed to cache OpenAI access token after refresh", {
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
      accountId,
    };
  }

  private async writeTokenSecrets(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    repoContext: RepoWriteContext | null,
    secrets: Record<string, string>
  ): Promise<void> {
    if (tokenState.source === "repo") {
      if (tokenState.repoId === null || !repoContext) {
        throw new Error("Repository-scoped OpenAI tokens require a repository context");
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
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    repoContext: RepoWriteContext | null,
    refreshToken: string
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS; attempt++) {
      try {
        await this.writeTokenSecrets(tokenState, repoContext, {
          OPENAI_OAUTH_REFRESH_TOKEN: refreshToken,
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

  private async handleUnauthorizedRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    readTokenState: () => Promise<OpenAITokenState | null>,
    repoContext: RepoWriteContext | null
  ): Promise<OpenAITokenRefreshResult> {
    this.log.warn("OpenAI refresh got 401, checking for concurrent rotation", {
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
          accountId: reread.accountId,
        };
      }

      if (reread?.type === "refresh" && reread.refreshToken !== tokenState.refreshToken) {
        this.log.info("Detected concurrent token rotation, retrying");
        return this.attemptRefresh(reread, repoContext);
      }

      this.log.error("OpenAI refresh token rejected and no newer token was found", {
        source: tokenState.source,
        repo_id: tokenState.repoId,
        action: "re-run OpenAI OAuth login",
      });
    } catch (retryErr) {
      this.log.error("Retry after 401 also failed", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return { ok: false, status: 401, error: "OpenAI token refresh failed: unauthorized" };
  }
}

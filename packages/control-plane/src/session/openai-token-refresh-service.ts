import {
  refreshOpenAIToken,
  extractOpenAIAccountId,
  OpenAITokenRefreshError,
} from "../auth/openai";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS = 3;
const ROTATED_REFRESH_TOKEN_PERSIST_RETRY_DELAY_MS = 100;

/**
 * Where a session's OpenAI OAuth tokens are read from and rotated back to. A
 * session reads from its own secret scope first — the environment for
 * environment-launched sessions, the repo for repo-launched ones (§6.4/§7.4) —
 * then falls back to global. Each variant carries everything needed to write
 * the rotated tokens back to the same place, so refresh never has to re-derive
 * the identity (and the old repoId-null guard disappears).
 */
type TokenSecretSource =
  | { kind: "environment"; environmentId: string }
  | { kind: "repo"; repoId: number; repoOwner: string; repoName: string }
  | { kind: "global" };

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | { type: "refresh"; refreshToken: string; source: TokenSecretSource };

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
    return this.refreshFromState(() => this.readTokenState(session));
  }

  /**
   * Refresh using only the deployment-wide global secrets — no session/repo.
   * Used by callers that run before a session exists (e.g. the repo classifier).
   */
  async refreshGlobal(): Promise<OpenAITokenRefreshResult> {
    return this.refreshFromState(() => this.readGlobalTokenState());
  }

  private async refreshFromState(
    readTokenState: () => Promise<OpenAITokenState | null>
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
      return await this.attemptRefresh(tokenState);
    } catch (e) {
      if (e instanceof OpenAITokenRefreshError && e.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState);
      }

      this.log.error("OpenAI token refresh failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 502, error: "OpenAI token refresh failed" };
    }
  }

  private getTokenStateFromSecrets(
    secrets: Record<string, string>,
    source: TokenSecretSource
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
    };
  }

  /**
   * The session's own secret source, or null for repo-less sessions with no
   * environment (global-only). Environment-launched sessions resolve to the
   * environment and never read member repo secrets (§6.4/§7.4).
   */
  private async resolveSessionSecretSource(session: SessionRow): Promise<TokenSecretSource | null> {
    if (session.environment_id) {
      return { kind: "environment", environmentId: session.environment_id };
    }
    if (session.repo_owner && session.repo_name) {
      const repoId = await this.ensureRepoId(session);
      return {
        kind: "repo",
        repoId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
      };
    }
    return null;
  }

  private async readSecretsForSource(source: TokenSecretSource): Promise<Record<string, string>> {
    switch (source.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(
          source.environmentId
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(source.repoId);
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets();
    }
  }

  private async writeSecretsForSource(
    source: TokenSecretSource,
    secrets: Record<string, string>
  ): Promise<void> {
    switch (source.kind) {
      case "environment":
        await new EnvironmentSecretsStore(this.db, this.encryptionKey).setSecrets(
          source.environmentId,
          secrets
        );
        return;
      case "repo":
        await new RepoSecretsStore(this.db, this.encryptionKey).setSecrets(
          source.repoId,
          source.repoOwner,
          source.repoName,
          secrets
        );
        return;
      case "global":
        await new GlobalSecretsStore(this.db, this.encryptionKey).setSecrets(secrets);
        return;
    }
  }

  private async readTokenState(session: SessionRow): Promise<OpenAITokenState | null> {
    const source = await this.resolveSessionSecretSource(session);
    if (source) {
      const secrets = await this.readSecretsForSource(source);
      const state = this.getTokenStateFromSecrets(secrets, source);
      if (state) {
        return state;
      }
    }

    const globalSecrets = await this.readSecretsForSource({ kind: "global" });
    return this.getTokenStateFromSecrets(globalSecrets, { kind: "global" });
  }

  private async readGlobalTokenState(): Promise<OpenAITokenState | null> {
    const globalSecrets = await this.readSecretsForSource({ kind: "global" });
    return this.getTokenStateFromSecrets(globalSecrets, { kind: "global" });
  }

  private async attemptRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>
  ): Promise<OpenAITokenRefreshResult> {
    const tokens = await refreshOpenAIToken(tokenState.refreshToken);
    const accountId = extractOpenAIAccountId(tokens);
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
    let refreshTokenPersisted = false;

    try {
      await this.writeRotatedRefreshToken(tokenState, tokens.refresh_token);
      refreshTokenPersisted = true;

      this.log.info("OpenAI refresh token rotated", {
        source: tokenState.source.kind,
        ...this.logContextForSource(tokenState.source),
      });
    } catch (e) {
      this.log.error("OPENAI_OAUTH_REFRESH_TOKEN_PERSIST_FAILED_AFTER_ROTATION", {
        source: tokenState.source.kind,
        ...this.logContextForSource(tokenState.source),
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

        await this.writeSecretsForSource(tokenState.source, cacheSecrets);

        this.log.info("OpenAI access token cached", {
          source: tokenState.source.kind,
          ...this.logContextForSource(tokenState.source),
          has_account_id: !!accountId,
        });
      } catch (e) {
        this.log.warn("Failed to cache OpenAI access token after refresh", {
          source: tokenState.source.kind,
          ...this.logContextForSource(tokenState.source),
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

  private async writeRotatedRefreshToken(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    refreshToken: string
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= ROTATED_REFRESH_TOKEN_PERSIST_ATTEMPTS; attempt++) {
      try {
        await this.writeSecretsForSource(tokenState.source, {
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
    readTokenState: () => Promise<OpenAITokenState | null>
  ): Promise<OpenAITokenRefreshResult> {
    this.log.warn("OpenAI refresh got 401, checking for concurrent rotation", {
      source: tokenState.source.kind,
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
        return this.attemptRefresh(reread);
      }

      this.log.error("OpenAI refresh token rejected and no newer token was found", {
        source: tokenState.source.kind,
        ...this.logContextForSource(tokenState.source),
        action: "re-run OpenAI OAuth login",
      });
    } catch (retryErr) {
      this.log.error("Retry after 401 also failed", {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return { ok: false, status: 401, error: "OpenAI token refresh failed: unauthorized" };
  }

  private logContextForSource(source: TokenSecretSource): Record<string, string | number> {
    switch (source.kind) {
      case "environment":
        return { environment_id: source.environmentId };
      case "repo":
        return {
          repo_id: source.repoId,
          repo_owner: source.repoOwner,
          repo_name: source.repoName,
        };
      case "global":
        return {};
    }
  }
}

import {
  OpenAITokenBroker,
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenUnauthorizedError,
  OpenAITokenUpstreamError,
  type OpenAIToken,
} from "../auth/openai-token-broker";
import type { OAuthSecretScope } from "../db/scoped-oauth-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { resolveSessionOAuthSecretScope } from "./session-target-secrets";
import type { SessionRow } from "./types";

export {
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenUnauthorizedError,
  OpenAITokenUpstreamError,
  type OpenAIToken,
} from "../auth/openai-token-broker";

export type OpenAITokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number; accountId?: string }
  | { ok: false; status: number; error: string };

/** Resolves a session into OAuth secret scopes before delegating to the provider broker. */
export class OpenAITokenRefreshService {
  private readonly broker: OpenAITokenBroker;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {
    this.broker = new OpenAITokenBroker(db, encryptionKey, log);
  }

  async refresh(session: SessionRow): Promise<OpenAIToken> {
    let sessionScope: OAuthSecretScope | null;
    try {
      sessionScope = await resolveSessionOAuthSecretScope(session, this.ensureRepoId);
    } catch (error) {
      this.log.error("Failed to resolve OpenAI token secret scope", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new OpenAITokenStorageError("Failed to read token state", { cause: error });
    }
    const scopes: OAuthSecretScope[] = sessionScope
      ? [sessionScope, { kind: "global" }]
      : [{ kind: "global" }];
    return this.broker.refreshScopes(scopes);
  }

  /** Global-only compatibility adapter used by the bot classification route. */
  async refreshGlobal(): Promise<OpenAITokenRefreshResult> {
    try {
      const token = await this.broker.refreshGlobal();
      return { ok: true, ...token };
    } catch (error) {
      if (error instanceof OpenAITokenNotConfiguredError) {
        return { ok: false, status: 404, error: error.message };
      }
      if (error instanceof OpenAITokenUnauthorizedError) {
        return { ok: false, status: 401, error: error.message };
      }
      if (error instanceof OpenAITokenStorageError) {
        return { ok: false, status: 500, error: error.message };
      }
      if (error instanceof OpenAITokenUpstreamError) {
        return { ok: false, status: 502, error: error.message };
      }
      throw error;
    }
  }
}

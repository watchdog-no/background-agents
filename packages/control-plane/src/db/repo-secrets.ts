import { decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  SecretDecryptionError,
  assertScopeKeyCapacity,
  decryptSecretRows,
  encryptSecretEntries,
  prepareSecretsForWrite,
  toSecretMetadata,
} from "./scoped-secrets";
import type { SecretsWriteResult } from "./scoped-secrets";
import { normalizeKey } from "./secrets-validation";
import type { SecretMetadata, SecretWithValue } from "./secrets-validation";

export type { SecretMetadata, SecretWithValue } from "./secrets-validation";

const log = createLogger("repo-secrets");

export class RepoSecretsStore {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(
    repoId: number,
    repoOwner: string,
    repoName: string,
    secrets: Record<string, string>
  ): Promise<SecretsWriteResult> {
    const owner = repoOwner.toLowerCase();
    const name = repoName.toLowerCase();
    const now = Date.now();
    const normalized = prepareSecretsForWrite(secrets);

    const existingKeys = await this.db
      .prepare("SELECT key FROM repo_secrets WHERE repo_id = ?")
      .bind(repoId)
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    assertScopeKeyCapacity("Repository", existingKeySet, incomingKeys);

    const { entries, created, updated } = await encryptSecretEntries(
      normalized,
      existingKeySet,
      this.encryptionKey
    );

    const statements = entries.map((entry) =>
      this.db
        .prepare(
          `INSERT INTO repo_secrets
           (repo_id, repo_owner, repo_name, key, encrypted_value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(repo_id, key) DO UPDATE SET
             repo_owner = excluded.repo_owner,
             repo_name = excluded.repo_name,
             encrypted_value = excluded.encrypted_value,
             updated_at = excluded.updated_at`
        )
        .bind(repoId, owner, name, entry.key, entry.encryptedValue, now, now)
    );

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(repoId: number): Promise<SecretMetadata[]> {
    const result = await this.db
      .prepare(
        "SELECT key, created_at, updated_at FROM repo_secrets WHERE repo_id = ? ORDER BY key"
      )
      .bind(repoId)
      .all<{ key: string; created_at: number; updated_at: number }>();

    return toSecretMetadata(result.results || []);
  }

  async listSecrets(repoId: number): Promise<SecretWithValue[]> {
    const result = await this.db
      .prepare(
        "SELECT key, encrypted_value, created_at, updated_at FROM repo_secrets WHERE repo_id = ? ORDER BY key"
      )
      .bind(repoId)
      .all<{ key: string; encrypted_value: string; created_at: number; updated_at: number }>();

    const rows = result.results || [];
    return Promise.all(
      rows.map(async (row) => {
        try {
          const value = await decryptToken(row.encrypted_value, this.encryptionKey);
          return {
            key: row.key,
            value,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        } catch (e) {
          log.warn("Failed to decrypt secret while listing secrets", {
            repo_id: repoId,
            key: row.key,
            error: e instanceof Error ? e.message : String(e),
          });
          return {
            key: row.key,
            value: null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            decryptionFailed: true,
          };
        }
      })
    );
  }

  async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = ?")
      .bind(repoId)
      .all<{ key: string; encrypted_value: string }>();

    try {
      return await decryptSecretRows(result.results || [], this.encryptionKey);
    } catch (e) {
      if (e instanceof SecretDecryptionError) {
        log.error("Failed to decrypt secret", {
          repo_id: repoId,
          key: e.key,
          error: e.cause instanceof Error ? e.cause.message : String(e.cause),
        });
        throw new Error(`Failed to decrypt secret '${e.key}'`);
      }
      throw e;
    }
  }

  async deleteSecret(repoId: number, key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM repo_secrets WHERE repo_id = ? AND key = ?")
      .bind(repoId, normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }
}

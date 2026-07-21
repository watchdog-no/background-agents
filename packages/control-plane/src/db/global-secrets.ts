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
import type { SqlDatabase } from "./sql-database";

const log = createLogger("global-secrets");

export class GlobalSecretsStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async setSecrets(secrets: Record<string, string>): Promise<SecretsWriteResult> {
    const now = Date.now();
    const normalized = prepareSecretsForWrite(secrets);

    const existingKeys = await this.db
      .prepare("SELECT key FROM global_secrets")
      .all<{ key: string }>();
    const existingKeySet = new Set((existingKeys.results || []).map((r) => r.key));

    const incomingKeys = Object.keys(normalized);
    assertScopeKeyCapacity("Global secrets", existingKeySet, incomingKeys);

    const { entries, created, updated } = await encryptSecretEntries(
      normalized,
      existingKeySet,
      this.encryptionKey
    );

    const statements = entries.map((entry) =>
      this.db
        .prepare(
          `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             encrypted_value = excluded.encrypted_value,
             updated_at = excluded.updated_at`
        )
        .bind(entry.key, entry.encryptedValue, now, now)
    );

    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return { created, updated, keys: incomingKeys };
  }

  async listSecretKeys(): Promise<SecretMetadata[]> {
    const result = await this.db
      .prepare("SELECT key, created_at, updated_at FROM global_secrets ORDER BY key")
      .all<{ key: string; created_at: number; updated_at: number }>();

    return toSecretMetadata(result.results || []);
  }

  async listSecrets(): Promise<SecretWithValue[]> {
    const result = await this.db
      .prepare(
        "SELECT key, encrypted_value, created_at, updated_at FROM global_secrets ORDER BY key"
      )
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
          log.warn("Failed to decrypt global secret while listing secrets", {
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

  async getDecryptedSecrets(): Promise<Record<string, string>> {
    const result = await this.db
      .prepare("SELECT key, encrypted_value FROM global_secrets")
      .all<{ key: string; encrypted_value: string }>();

    try {
      return await decryptSecretRows(result.results || [], this.encryptionKey);
    } catch (e) {
      if (e instanceof SecretDecryptionError) {
        log.error("Failed to decrypt global secret", {
          key: e.key,
          error: e.cause instanceof Error ? e.cause.message : String(e.cause),
        });
        throw new Error(`Failed to decrypt global secret '${e.key}'`);
      }
      throw e;
    }
  }

  async deleteSecret(key: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM global_secrets WHERE key = ?")
      .bind(normalizeKey(key))
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }
}

import { generateId } from "../auth/crypto";
import type { ProviderProfile } from "../auth/user/provider-profile";
import type { SqlDatabase } from "./sql-database";
import { UserStore } from "./user-store";

export type BrowserAuthProvider = "github" | "google";

/**
 * Materializes a verified browser identity in both the canonical user model
 * and Better Auth before Better Auth performs its account lookup.
 */
export class D1BrowserUserProvisioner {
  private readonly userStore: UserStore;

  constructor(private readonly db: SqlDatabase) {
    this.userStore = new UserStore(db);
  }

  async provision(provider: BrowserAuthProvider, profile: ProviderProfile): Promise<void> {
    const providerUserId = profile.user.id.trim();
    const email = profile.user.email?.trim().toLowerCase();
    if (!providerUserId || !email || !profile.user.emailVerified) {
      throw new Error("Browser user provisioning requires a verified provider identity and email");
    }

    const resolution = await this.userStore.resolveOrCreateUser({
      provider,
      providerUserId,
      providerEmail: email,
      displayName: profile.user.name,
      avatarUrl: profile.user.image,
    });
    const canonicalUser = await this.userStore.getUserById(resolution.id);
    if (!canonicalUser) {
      throw new Error(`Canonical user ${resolution.id} was not found after resolution`);
    }

    const now = new Date().toISOString();
    const name =
      profile.user.name?.trim() ||
      canonicalUser.displayName?.trim() ||
      canonicalUser.email ||
      email;
    const image = profile.user.image ?? canonicalUser.avatarUrl;

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO auth_users (
             id, name, email, emailVerified, image, createdAt, updatedAt
           ) VALUES (?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             email = excluded.email,
             emailVerified = 1,
             image = excluded.image,
             updatedAt = excluded.updatedAt`
        )
        .bind(
          canonicalUser.id,
          name,
          email,
          image,
          new Date(canonicalUser.createdAt).toISOString(),
          now
        ),
      this.db
        .prepare(
          `INSERT INTO auth_accounts (
             id, accountId, providerId, userId, accessToken, refreshToken,
             idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope,
             password, createdAt, updatedAt
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
           ON CONFLICT(providerId, accountId) DO UPDATE SET
             userId = excluded.userId,
             updatedAt = excluded.updatedAt`
        )
        .bind(generateId(), providerUserId, provider, canonicalUser.id, now, now),
    ]);
  }
}

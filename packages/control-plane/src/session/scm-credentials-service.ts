import type { SourceControlProvider } from "../source-control";
import { SourceControlProviderError } from "../source-control/errors";
import type { Logger } from "../logger";

export type ScmCredentialsResult =
  | {
      ok: true;
      username: string;
      password: string;
      expiresAtEpochMs: number;
      scmProvider: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Service that mints short-lived SCM credentials for the sandbox-side git
 * credential helper.
 *
 * Sits in front of {@link SourceControlProvider.generateCredentialHelperAuth}
 * and adapts upstream errors into a discriminated union that the HTTP handler
 * can map directly to a response. Never logs the returned password.
 */
export class ScmCredentialsService {
  constructor(
    private readonly provider: SourceControlProvider,
    private readonly log: Logger
  ) {}

  async getCredentials(): Promise<ScmCredentialsResult> {
    try {
      const auth = await this.provider.generateCredentialHelperAuth();
      return {
        ok: true,
        username: auth.username,
        password: auth.password,
        expiresAtEpochMs: auth.expiresAtEpochMs,
        scmProvider: this.provider.name,
      };
    } catch (e) {
      if (e instanceof SourceControlProviderError) {
        const status = e.errorType === "permanent" ? 503 : 502;
        this.log.warn("SCM credential helper auth failed", {
          scm_provider: this.provider.name,
          error_type: e.errorType,
          error: e.message,
        });
        return { ok: false, status, error: e.message };
      }

      this.log.error("Unexpected error generating SCM credentials", {
        scm_provider: this.provider.name,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        status: 500,
        error: "Failed to generate SCM credentials",
      };
    }
  }
}

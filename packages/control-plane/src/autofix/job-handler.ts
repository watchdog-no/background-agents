import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import { githubAutofixFeedbackKey } from "../db/pr-autofix-feedback-store";
import type { JobDelivery, JobOutcome } from "../jobs";
import { SourceControlProviderError } from "../source-control/errors";
import { AutofixDeferredError, type AutofixProcessResult } from "./service";

/** How long to wait before retrying feedback the session could not accept yet. */
const AUTOFIX_DEFERRAL_DELAY_SECONDS = 60;

/** Re-enqueues an envelope for a later delivery. */
type Redeliver = (envelope: GitHubAutofixEnvelope, delaySeconds: number) => Promise<void>;

interface AutofixProcessor {
  process(envelope: GitHubAutofixEnvelope): Promise<AutofixProcessResult>;
}

interface FailureStore {
  recordError(feedbackKey: string, error: string): Promise<void>;
  markFailed(
    feedbackKey: string,
    reason: string,
    error: string,
    decidedAt: number
  ): Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides one `github.autofix` delivery: a processed envelope is
 * acknowledged; a permanent provider error is made terminal in the ledger
 * and acknowledged; anything else is recorded and retried, and the last
 * delivery is made terminal first so the ledger explains the dead letter.
 */
export class AutofixJobHandler {
  constructor(
    private readonly service: AutofixProcessor,
    private readonly feedbackStore: FailureStore,
    private readonly now: () => number,
    private readonly redeliver: Redeliver
  ) {}

  async handle(envelope: GitHubAutofixEnvelope, delivery: JobDelivery): Promise<JobOutcome> {
    try {
      await this.service.process(envelope);
      return "ack";
    } catch (error) {
      const feedbackKey = githubAutofixFeedbackKey(envelope);
      const detail = errorMessage(error);
      if (error instanceof AutofixDeferredError) {
        // Waiting, not failing: the receipt stays undecided. Re-enqueue rather
        // than retry so a hold does not spend the delivery-attempt budget that
        // exists to catch genuinely broken messages. The service bounds how
        // long it will keep deferring, so this cannot loop forever.
        await this.redeliver(envelope, error.delaySeconds ?? AUTOFIX_DEFERRAL_DELAY_SECONDS);
        return "ack";
      }
      if (error instanceof SourceControlProviderError && error.errorType === "permanent") {
        await this.feedbackStore.markFailed(
          feedbackKey,
          "permanent_provider_error",
          detail,
          this.now()
        );
        return "ack";
      }
      await this.feedbackStore.recordError(feedbackKey, detail);
      if (delivery.attempts >= delivery.maxAttempts) {
        const failed = await this.feedbackStore.markFailed(
          feedbackKey,
          "delivery_attempts_exhausted",
          detail,
          this.now()
        );
        if (!failed) return "ack";
      }
      return { retry: true };
    }
  }
}

import { githubAutofixEnvelopeSchema, type GitHubAutofixEnvelope } from "@open-inspect/shared";
import { githubAutofixFeedbackKey } from "../db/pr-autofix-feedback-store";
import { SourceControlProviderError } from "../source-control/errors";
import { AutofixDeferredError, type AutofixProcessResult } from "./service";

/** How long to wait before retrying feedback the session could not accept yet. */
export const AUTOFIX_DEFERRAL_DELAY_SECONDS = 60;

interface AutofixProcessor {
  process(body: GitHubAutofixEnvelope): Promise<AutofixProcessResult>;
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

interface QueueMessage {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutofixQueueConsumer {
  constructor(
    private readonly service: AutofixProcessor,
    private readonly feedbackStore: FailureStore,
    private readonly now: () => number,
    private readonly maxDeliveryAttempts: number
  ) {}

  async consume(message: QueueMessage): Promise<void> {
    const parsed = githubAutofixEnvelopeSchema.safeParse(message.body);
    if (!parsed.success) {
      message.retry();
      return;
    }

    try {
      await this.service.process(parsed.data);
      message.ack();
    } catch (error) {
      const feedbackKey = githubAutofixFeedbackKey(parsed.data);
      const detail = errorMessage(error);
      if (error instanceof AutofixDeferredError) {
        // Back-pressure, not a failure: leave the receipt undecided and retry
        // later. Exhausting the platform's retries sends the message to the DLQ,
        // which is visible, rather than dropping the feedback silently.
        message.retry({ delaySeconds: AUTOFIX_DEFERRAL_DELAY_SECONDS });
        return;
      }
      if (error instanceof SourceControlProviderError && error.errorType === "permanent") {
        await this.feedbackStore.markFailed(
          feedbackKey,
          "permanent_provider_error",
          detail,
          this.now()
        );
        message.ack();
        return;
      }
      await this.feedbackStore.recordError(feedbackKey, detail);
      if (message.attempts >= this.maxDeliveryAttempts) {
        const failed = await this.feedbackStore.markFailed(
          feedbackKey,
          "delivery_attempts_exhausted",
          detail,
          this.now()
        );
        if (!failed) {
          message.ack();
          return;
        }
      }
      message.retry();
    }
  }
}

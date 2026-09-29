import {
  contextTokensFromUsage,
  type SandboxEvent,
} from "@open-inspect/shared/types/sandbox-events";
import { generateId } from "../../auth/crypto";
import type { BackgroundTasks } from "../../platform-ports";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SessionBudgetService } from "../budget-service";
import type { UsageRepository } from "../usage-repository";
import { persistSandboxEvent, type SandboxEventContext } from "./context";

/**
 * Streaming/timeline family: the high-frequency events that narrate an
 * execution (tokens, steps, tool activity, compaction). Every event here is
 * broadcast to clients; the ones with a durable representation also record
 * to the timeline (steps renew activity, accumulate cost, and persist usage). Nothing
 * here transitions session state; a step whose turn has already ended
 * refreshes the metrics projection itself, as no settle for that turn is still
 * to come. Also owns the timeline-observer path (`recordTimelineEvent`) for
 * events that persist and broadcast unchanged.
 */
export class SandboxStreamingEventHandler {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly eventRepository: EventRepository,
    private readonly callbackService: CallbackNotificationService,
    private readonly messenger: SessionMessenger,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly budgetService: SessionBudgetService,
    private readonly repository: SessionCoreRepository,
    private readonly usageRepository: UsageRepository,
    private readonly refreshMetricsAfterStep: (messageId: string | null) => void
  ) {}

  handleToken(event: Extract<SandboxEvent, { type: "token" }>, context: SandboxEventContext): void {
    if (context.messageId) {
      this.eventRepository.upsertTokenEvent(context.messageId, event, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  handleContextCompacted(
    event: Extract<SandboxEvent, { type: "context_compacted" }>,
    context: SandboxEventContext
  ): void {
    const eventId = generateId();
    this.eventRepository.createContextCompactionEvent({
      id: eventId,
      type: event.type,
      data: JSON.stringify(event),
      messageId: event.messageId,
      createdAt: context.now,
    });
    this.repository.setSessionContextUsage(0, null, context.now);
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  /**
   * Legacy compaction marker emitted by older fork sandbox runtimes. Persisted
   * so those sessions keep hydrating, and treated like `context_compacted` for
   * the context gauge.
   */
  handleCompaction(
    event: Extract<SandboxEvent, { type: "compaction" }>,
    context: SandboxEventContext
  ): void {
    persistSandboxEvent(this.eventRepository, event, context);
    // Compaction shrinks the context, but the new size isn't known until the
    // next step. Clear the stored usage (keep the limit) so the gauge doesn't
    // show a stale pre-compaction count on reload until the next step_finish.
    this.repository.setSessionContextUsage(0, null, context.now);
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  handleReasoning(
    event: Extract<SandboxEvent, { type: "reasoning" }>,
    context: SandboxEventContext
  ): void {
    if (context.messageId) {
      this.eventRepository.upsertReasoningEvent(context.messageId, event, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  async handleStep(
    event: Extract<SandboxEvent, { type: "step_start" | "step_finish" }>,
    context: SandboxEventContext
  ): Promise<void> {
    this.updateLastActivity(context.now);
    // Persist current context-window pressure from the parent session's steps.
    // Subtask steps belong to a child session's context, so ignore them.
    // Include cached prompt and generated tokens so long responses don't show
    // false headroom near compaction.
    if (event.type === "step_finish" && !event.isSubtask && event.tokens !== undefined) {
      this.repository.setSessionContextUsage(
        contextTokensFromUsage(event.tokens),
        typeof event.contextLimit === "number" ? event.contextLimit : null,
        context.now
      );
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
    if (event.type === "step_finish") {
      try {
        let persistenceFailure: { error: unknown } | null = null;
        try {
          this.usageRepository.recordStepUsage(event, context.messageId, context.now);
        } catch (error) {
          persistenceFailure = { error };
        }
        try {
          await this.budgetService.ingestStepFinish(event, context.messageId, context.now);
        } catch (error) {
          if (persistenceFailure) throw persistenceFailure.error;
          throw error;
        }
        if (persistenceFailure) throw persistenceFailure.error;
      } finally {
        // Submitted so a failed refresh is logged at the task boundary rather
        // than replacing the step's own outcome.
        this.backgroundTasks.submit(async () => this.refreshMetricsAfterStep(context.messageId), {
          name: "session_index.refresh_step_metrics",
          context: { message_id: context.messageId },
        });
      }
    }
  }

  handleToolCall(
    event: Extract<SandboxEvent, { type: "tool_call" }>,
    context: SandboxEventContext
  ): void {
    this.updateLastActivity(context.now);
    const messageId = context.messageId;
    if (messageId) {
      this.eventRepository.upsertToolCallEvent(messageId, event, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });

    if (messageId && !event.truncated?.fields.some((field) => field.startsWith("args."))) {
      this.backgroundTasks.submit(() => this.callbackService.notifyToolCall(messageId, event), {
        name: "callback.notify_tool_call",
        context: { message_id: messageId },
      });
    }
  }

  /**
   * Persist-and-broadcast for the router's timeline-observer cases
   * (`tool_result`, `error`, `warning`, `user_message`, and the push
   * terminal events, which additionally settle `SandboxPushService`).
   */
  recordTimelineEvent(event: SandboxEvent, context: SandboxEventContext): void {
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
  }
}

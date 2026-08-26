/**
 * Target classifier for the Slack bot.
 *
 * Resolves which target — a repository or a saved environment — a Slack
 * message refers to. Deterministic routing handles configured rules, channel
 * associations, explicit mentions, and the configured default before the LLM
 * fallback is considered.
 */

import type { Env, ThreadContext, ClassificationResult } from "../types";
import { buildRepoDescriptions } from "./repos";
import { buildEnvironmentDescriptions } from "./environments";
import { loadTargetCatalog, type TargetCatalog } from "./catalog";
import {
  matchTargetId,
  resolveChannelTargets,
  resolveExplicitTargets,
  resolveRoutingRuleTargets,
} from "./routing";
import { escapeMrkdwnText } from "@open-inspect/shared/slack";
import type {
  ClassifyErrorResponse,
  ClassifyRawResult,
  ConfidenceLevel,
} from "@open-inspect/shared/types/repository-catalog";
import { targetId, targetLabel, targetValue, type SlackSessionTarget } from "../targets";
import { signedControlPlaneFetch } from "../internal-auth";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_TARGET_TOOL_NAME = "classify_repository";
const DEFAULT_CLASSIFICATION_MODEL = "anthropic/claude-haiku-4-5";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];

/**
 * Build the classification prompt for the LLM over the target catalog.
 */
function buildClassificationPrompt(
  message: string,
  catalog: TargetCatalog,
  context?: ThreadContext
): string {
  const repoDescriptions = buildRepoDescriptions(catalog.repos);

  const environmentSection =
    catalog.environments.length > 0
      ? `
## Available Environments

Environments are saved multi-repository workspaces. Prefer an environment over a
single repository when the message names it, or when the work spans several of
its repositories.
${buildEnvironmentDescriptions(catalog.environments)}
`
      : "";

  let contextSection = "";

  if (context) {
    contextSection = `
## Context

**Channel**: ${context.channelName ? `#${context.channelName}` : context.channelId}
${context.channelDescription ? `**Channel Description**: ${context.channelDescription}` : ""}
${context.threadTs ? `**In Thread**: Yes` : "**In Thread**: No"}
${
  context.previousMessages?.length
    ? `**Previous Messages in Thread**:
${context.previousMessages.map((m) => `- ${m}`).join("\n")}`
    : ""
}`;
  }

  return `You are a target classifier for a coding agent. Your job is to determine which code repository or environment a Slack message is referring to.

## Available Repositories
${repoDescriptions}
${environmentSection}
${contextSection}

## User's Message
${message}

## Your Task

Analyze the message and context to determine which repository or environment the user is referring to.

Consider:
1. Explicit mentions of repository or environment names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Channel associations (some channels are associated with specific repos)
5. Context from previous messages in the thread

## Response Format

Return your decision by calling the ${CLASSIFY_TARGET_TOOL_NAME} tool with:
- repoId: a repository "owner/name", an environment id ("env_…"), or null if unclear
- confidence: "high" | "medium" | "low"
- reasoning: brief explanation
- alternatives: other possible targets when confidence is not high`;
}

/**
 * Parsed and validated classification result.
 */
interface LLMResponse {
  targetId: string | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives: string[];
}

/**
 * Validate the raw classifier output (from the endpoint) into LLMResponse.
 */
function normalizeModelResponse(raw: unknown): LLMResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("LLM response was not an object");
  }

  const input = raw as Record<string, unknown>;
  const rawTargetId = input.targetId;
  const targetId =
    rawTargetId === null
      ? null
      : typeof rawTargetId === "string" && rawTargetId.trim().length > 0
        ? rawTargetId.trim()
        : null;

  const rawConfidence = typeof input.confidence === "string" ? input.confidence.trim() : "";
  const confidence = rawConfidence.toLowerCase();
  if (!CONFIDENCE_LEVELS.includes(confidence as ClassificationResult["confidence"])) {
    throw new Error(`Invalid confidence value: ${rawConfidence || String(input.confidence)}`);
  }

  if (typeof input.reasoning !== "string" || input.reasoning.trim().length === 0) {
    throw new Error("Missing reasoning in LLM response");
  }

  if (!Array.isArray(input.alternatives)) {
    throw new Error("Alternatives must be an array");
  }

  const alternatives = input.alternatives
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (alternatives.length !== input.alternatives.length) {
    throw new Error("Invalid alternatives in LLM response");
  }

  return {
    targetId,
    confidence: confidence as ClassificationResult["confidence"],
    reasoning: input.reasoning.trim(),
    alternatives: [...new Set(alternatives)],
  };
}

class ClassifierEndpointError extends Error {
  constructor(
    readonly reason: ClassificationResult["failureReason"],
    message: string
  ) {
    super(message);
  }
}

/**
 * Run the classification via the control-plane `/classify` endpoint (which owns
 * the OAuth / API-key credentials). Throws ClassifierEndpointError on failure.
 */
async function callClassifyEndpoint(
  env: Env,
  prompt: string,
  model: string,
  traceId?: string
): Promise<ClassifyRawResult> {
  const url = "https://internal/classify";
  const body = JSON.stringify({ prompt, model });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body,
    traceId,
  });

  if (!response.ok) {
    let reason: ClassificationResult["failureReason"] = "provider_error";
    let message = `classify endpoint returned ${response.status}`;
    try {
      const errBody = (await response.json()) as ClassifyErrorResponse;
      if (errBody.reason) reason = errBody.reason;
      if (errBody.message) message = errBody.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ClassifierEndpointError(reason, message);
  }

  return (await response.json()) as ClassifyRawResult;
}

/**
 * Repository classifier class.
 */
export class RepoClassifier {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Match the message against the workspace's Slack routing rules (resolution
   * lives in {@link resolveRoutingRuleTargets}).
   *
   * Returns a high-confidence result when exactly one accessible target matches,
   * a clarification result when several distinct targets match (so the user
   * picks rather than the bot guessing), or `null` when no rule applies — in
   * which case the caller continues through the remaining routing stages.
   */
  private async classifyByRoutingRules(
    message: string,
    catalog: TargetCatalog,
    traceId?: string
  ): Promise<ClassificationResult | null> {
    const resolved = await resolveRoutingRuleTargets(this.env, message, catalog, traceId);
    if (resolved.length === 0) return null;

    if (resolved.length === 1) {
      const { target, keyword } = resolved[0];
      log.info("classifier.routing_rule_match", {
        trace_id: traceId,
        target_id: targetId(target),
        keyword,
      });
      return {
        target,
        confidence: "high",
        // Reasoning renders as mrkdwn; keyword and label are both user text.
        reasoning: `Matched routing rule "${escapeMrkdwnText(keyword)}" → ${escapeMrkdwnText(targetLabel(target))}`,
        needsClarification: false,
      };
    }

    return {
      target: null,
      confidence: "medium",
      reasoning: "Multiple routing rules matched; asking which one to use.",
      alternatives: resolved.map((t) => t.target),
      needsClarification: true,
    };
  }

  /**
   * Route on the channel's associated targets (resolution lives in
   * {@link resolveChannelTargets}).
   *
   * Returns a high-confidence result when the channel is associated with
   * exactly one target. Several associated repositories continue through the
   * explicit/default stages, while a multi-target set that includes an
   * environment asks the user deterministically.
   */
  private classifyByChannelAssociations(
    channelId: string,
    catalog: TargetCatalog,
    traceId?: string
  ): ClassificationResult | null {
    const targets = resolveChannelTargets(catalog, channelId);

    if (targets.length === 1) {
      const target = targets[0];
      log.info("classifier.channel_association_match", {
        trace_id: traceId,
        channel_id: channelId,
        target_id: targetId(target),
      });
      return {
        target,
        confidence: "high",
        // Reasoning renders as mrkdwn; the label is user text.
        reasoning: `Channel is associated with ${target.kind} ${escapeMrkdwnText(targetLabel(target))}`,
        needsClarification: false,
      };
    }

    if (targets.length > 1 && targets.some((target) => target.kind === "environment")) {
      return {
        target: null,
        confidence: "medium",
        reasoning: "This channel is associated with several targets; asking which one to use.",
        alternatives: targets,
        needsClarification: true,
      };
    }

    return null;
  }

  /**
   * Classify which target a message refers to.
   */
  async classify(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<ClassificationResult> {
    // The target catalog every stage below works over. Environments fail open
    // to []: an environments-fetch problem degrades the catalog — and with it
    // classification — to repository-only.
    const catalog = await loadTargetCatalog(this.env, traceId);

    // Only a fully empty catalog is unclassifiable — environments launch by id
    // without consulting the repo list, so they stay reachable when the repo
    // fetch degrades to [].
    if (catalog.repos.length === 0 && catalog.environments.length === 0) {
      return {
        target: null,
        confidence: "low",
        reasoning: "No repositories or environments are currently available.",
        needsClarification: true,
      };
    }

    // Deterministic routing rules (explicit keyword → repo or environment) take
    // precedence over everything below — including the single-repo shortcut,
    // which would otherwise make environment-targeted rules unreachable in
    // one-repo workspaces — but never override an active thread (handled before
    // classify is called).
    const routed = await this.classifyByRoutingRules(message, catalog, traceId);
    if (routed) {
      return routed;
    }

    // Channel associations are the second deterministic stage. Like routing
    // rules, they run before the single-repo shortcut so a channel associated
    // with an environment stays reachable in one-repo workspaces.
    const channelRouted = context?.channelId
      ? this.classifyByChannelAssociations(context.channelId, catalog, traceId)
      : null;
    if (channelRouted) {
      return channelRouted;
    }

    // With a single repository and no environments there is nothing to choose.
    if (catalog.repos.length === 1 && catalog.environments.length === 0) {
      return {
        target: { kind: "repository", repo: catalog.repos[0] },
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    const messageTargets = resolveExplicitTargets(message, catalog);
    const explicitTargets =
      messageTargets.length > 0 || !context?.previousMessages?.length
        ? messageTargets
        : resolveExplicitTargets(context.previousMessages.join("\n"), catalog);
    if (explicitTargets.length === 1) {
      const target = explicitTargets[0];
      log.info("classifier.explicit_target_match", {
        trace_id: traceId,
        target_id: targetId(target),
      });
      return {
        target,
        confidence: "high",
        reasoning: `Message or thread context explicitly names ${target.kind} ${escapeMrkdwnText(targetLabel(target))}.`,
        needsClarification: false,
      };
    }
    if (explicitTargets.length > 1) {
      return {
        target: null,
        confidence: "medium",
        reasoning: "The message names several targets; asking which one to use.",
        alternatives: explicitTargets,
        needsClarification: true,
      };
    }

    const configuredDefaultRepository = this.env.CLASSIFICATION_DEFAULT_REPOSITORY?.trim();
    const defaultTarget = configuredDefaultRepository
      ? matchTargetId(configuredDefaultRepository, catalog)
      : null;
    if (defaultTarget?.kind === "repository") {
      log.info("classifier.default_repository_match", {
        trace_id: traceId,
        target_id: defaultTarget.repo.fullName,
      });
      return {
        target: defaultTarget,
        confidence: "high",
        reasoning: `No explicit target matched; using the configured default repository ${escapeMrkdwnText(defaultTarget.repo.fullName)}.`,
        needsClarification: false,
      };
    }

    // Preserve the provider classifier as a fallback for deployments without a
    // valid default repository.
    try {
      const prompt = buildClassificationPrompt(message, catalog, context);

      const model = this.env.CLASSIFICATION_MODEL || DEFAULT_CLASSIFICATION_MODEL;
      const raw = await callClassifyEndpoint(this.env, prompt, model, traceId);
      const llmResult = normalizeModelResponse({ ...raw, targetId: raw.repoId });

      const matchedTarget = llmResult.targetId ? matchTargetId(llmResult.targetId, catalog) : null;

      // Resolve alternatives, deduplicated and never repeating the match.
      const alternatives: SlackSessionTarget[] = [];
      for (const altId of llmResult.alternatives) {
        const target = matchTargetId(altId, catalog);
        if (
          target &&
          (!matchedTarget || targetValue(target) !== targetValue(matchedTarget)) &&
          !alternatives.some((existing) => targetValue(existing) === targetValue(target))
        ) {
          alternatives.push(target);
        }
      }

      return {
        target: matchedTarget,
        confidence: llmResult.confidence,
        // Reasoning renders as mrkdwn and may quote target names or message
        // text; escape it at composition like the deterministic stages do.
        reasoning: escapeMrkdwnText(llmResult.reasoning),
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        needsClarification:
          !matchedTarget ||
          llmResult.confidence === "low" ||
          (llmResult.confidence === "medium" && alternatives.length > 0),
      };
    } catch (e) {
      const failureReason =
        e instanceof ClassifierEndpointError ? (e.reason ?? "provider_error") : "provider_error";

      log.error("classifier.classify", {
        trace_id: traceId,
        method: "endpoint",
        outcome: "error",
        failure_reason: failureReason,
        error: e instanceof Error ? e : new Error(String(e)),
        channel_id: context?.channelId,
      });

      return {
        target: null,
        confidence: "low",
        reasoning:
          "The target classifier failed to run, so I couldn't auto-detect the target. Please pick one below.",
        // No basis to suggest specific targets on a classification failure;
        // the picker lets the user search the full list.
        alternatives: undefined,
        needsClarification: true,
        failureReason,
      };
    }
  }
}

/**
 * Create a new classifier instance.
 */
export function createClassifier(env: Env): RepoClassifier {
  return new RepoClassifier(env);
}

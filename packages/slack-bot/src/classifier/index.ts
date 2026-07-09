/**
 * Repository classifier for the Slack bot.
 *
 * Builds the classification prompt and delegates the LLM call to the
 * control-plane `POST /classify` endpoint, which owns the subscription OAuth
 * credentials (and any API-key fallback). The bot matches the returned repo id
 * against its own repo list and decides whether clarification is needed.
 */

import { buildInternalAuthHeaders } from "@open-inspect/shared";
import type { ClassifyRawResult, ClassifyErrorResponse } from "@open-inspect/shared";
import type { Env, RepoConfig, ThreadContext, ClassificationResult } from "../types";
import { getAvailableRepos, buildRepoDescriptions } from "./repos";
import { resolveChannelTargets, resolveRoutingRuleTargets } from "./routing";
import { escapeMrkdwnText, type ConfidenceLevel } from "@open-inspect/shared";
import { targetId, targetLabel, type SlackSessionTarget } from "../targets";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_REPO_TOOL_NAME = "classify_repository";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];
// Anthropic, not OpenAI: the /classify endpoint runs inside a Cloudflare Worker,
// and OpenAI subscription OAuth routes to the chatgpt.com Codex backend, which
// edge-blocks Worker egress (403). The Anthropic OAuth path uses api.anthropic.com.
const DEFAULT_CLASSIFICATION_MODEL = "anthropic/claude-haiku-4-5";

/**
 * Build the classification prompt for the LLM.
 */
async function buildClassificationPrompt(
  env: Env,
  message: string,
  context?: ThreadContext,
  traceId?: string
): Promise<string> {
  const repoDescriptions = await buildRepoDescriptions(env, traceId);

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

  return `You are a repository classifier for a coding agent. Your job is to determine which code repository a Slack message is referring to.

## Available Repositories
${repoDescriptions}

${contextSection}

## User's Message
${message}

## Your Task

Analyze the message and context to determine which repository the user is referring to.

Consider:
1. Explicit mentions of repository names or aliases
2. Technical keywords that match repository technologies
3. File paths or code patterns mentioned
4. Channel associations (some channels are associated with specific repos)
5. Context from previous messages in the thread

## Response Format

Return your decision by calling the ${CLASSIFY_REPO_TOOL_NAME} tool with:
- repoId: "owner/name" or null if unclear
- confidence: "high" | "medium" | "low"
- reasoning: brief explanation
- alternatives: other possible repos when confidence is not high`;
}

/**
 * Parsed and validated classification result.
 */
interface LLMResponse {
  repoId: string | null;
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
  const rawRepoId = input.repoId;
  const repoId =
    rawRepoId === null
      ? null
      : typeof rawRepoId === "string" && rawRepoId.trim().length > 0
        ? rawRepoId.trim()
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
    repoId,
    confidence: confidence as ClassificationResult["confidence"],
    reasoning: input.reasoning.trim(),
    alternatives: [...new Set(alternatives)],
  };
}

/** Error thrown when the control-plane classifier endpoint fails to run. */
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
  const headers = {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
  const response = await env.CONTROL_PLANE.fetch("https://internal/classify", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, model }),
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
   * which case the caller falls through to channel association and the LLM.
   */
  private async classifyByRoutingRules(
    message: string,
    repos: RepoConfig[],
    traceId?: string
  ): Promise<ClassificationResult | null> {
    const resolved = await resolveRoutingRuleTargets(this.env, message, repos, traceId);
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
   * exactly one target. Several associated repositories fall through (`null`)
   * to the LLM, which already sees channel associations as a prompt signal —
   * but the LLM cannot pick an environment until environments join its
   * candidate set (Phase B), so a multi-target set that includes an
   * environment asks the user instead of silently dropping it.
   */
  private async classifyByChannelAssociations(
    channelId: string,
    repos: RepoConfig[],
    traceId?: string
  ): Promise<ClassificationResult | null> {
    const targets = await resolveChannelTargets(this.env, channelId, repos, traceId);

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
   * Classify which repository a message refers to.
   */
  async classify(
    message: string,
    context?: ThreadContext,
    traceId?: string
  ): Promise<ClassificationResult> {
    // Fetch available repos dynamically
    const repos = await getAvailableRepos(this.env, traceId);

    // If no repos available, return immediately
    if (repos.length === 0) {
      return {
        target: null,
        confidence: "low",
        reasoning: "No repositories are currently available.",
        needsClarification: true,
      };
    }

    // Deterministic routing rules (explicit keyword → repo or environment) take
    // precedence over everything below — including the single-repo shortcut,
    // which would otherwise make environment-targeted rules unreachable in
    // one-repo workspaces — but never override an active thread (handled before
    // classify is called).
    const routed = await this.classifyByRoutingRules(message, repos, traceId);
    if (routed) {
      return routed;
    }

    // Channel associations are the second deterministic stage. Like routing
    // rules, they run before the single-repo shortcut so a channel associated
    // with an environment stays reachable in one-repo workspaces.
    const channelRouted = context?.channelId
      ? await this.classifyByChannelAssociations(context.channelId, repos, traceId)
      : null;
    if (channelRouted) {
      return channelRouted;
    }

    // If only one repo, skip classification
    if (repos.length === 1) {
      return {
        target: { kind: "repository", repo: repos[0] },
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    // Delegate the LLM call to the control plane.
    try {
      const prompt = await buildClassificationPrompt(this.env, message, context, traceId);
      const model = this.env.CLASSIFICATION_MODEL || DEFAULT_CLASSIFICATION_MODEL;
      const raw = await callClassifyEndpoint(this.env, prompt, model, traceId);
      const llmResult = normalizeModelResponse(raw);

      // Find the matched repo
      let matchedRepo: RepoConfig | null = null;
      if (llmResult.repoId) {
        matchedRepo =
          repos.find(
            (r) =>
              r.id.toLowerCase() === llmResult.repoId!.toLowerCase() ||
              r.fullName.toLowerCase() === llmResult.repoId!.toLowerCase()
          ) || null;
      }

      // Find alternative repos
      const alternatives: SlackSessionTarget[] = [];
      for (const altId of llmResult.alternatives) {
        const altRepo = repos.find(
          (r) =>
            r.id.toLowerCase() === altId.toLowerCase() ||
            r.fullName.toLowerCase() === altId.toLowerCase()
        );
        if (altRepo && altRepo.id !== matchedRepo?.id) {
          alternatives.push({ kind: "repository", repo: altRepo });
        }
      }

      return {
        target: matchedRepo ? { kind: "repository", repo: matchedRepo } : null,
        confidence: llmResult.confidence,
        reasoning: llmResult.reasoning,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        needsClarification:
          !matchedRepo ||
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
          "The repository classifier failed to run, so I couldn't auto-detect the repository. Please select a repository.",
        // No basis to suggest specific repos on a classification failure; the
        // picker lets the user search the full list.
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

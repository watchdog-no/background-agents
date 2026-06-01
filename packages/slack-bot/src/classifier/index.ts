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
import type { ConfidenceLevel } from "@open-inspect/shared";
import { getAvailableRepos, buildRepoDescriptions, getReposByChannel } from "./repos";
import { createLogger } from "../logger";

const log = createLogger("classifier");
const CLASSIFY_REPO_TOOL_NAME = "classify_repository";
const CONFIDENCE_LEVELS: ClassificationResult["confidence"][] = ["high", "medium", "low"];
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
        repo: null,
        confidence: "low",
        reasoning: "No repositories are currently available.",
        needsClarification: true,
      };
    }

    // If only one repo, skip classification
    if (repos.length === 1) {
      return {
        repo: repos[0],
        confidence: "high",
        reasoning: "Only one repository is available.",
        needsClarification: false,
      };
    }

    // Check for channel-specific repos first
    if (context?.channelId) {
      const channelRepos = await getReposByChannel(this.env, context.channelId, traceId);
      if (channelRepos.length === 1) {
        return {
          repo: channelRepos[0],
          confidence: "high",
          reasoning: `Channel is associated with repository ${channelRepos[0].fullName}`,
          needsClarification: false,
        };
      }
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
      const alternatives: RepoConfig[] = [];
      for (const altId of llmResult.alternatives) {
        const altRepo = repos.find(
          (r) =>
            r.id.toLowerCase() === altId.toLowerCase() ||
            r.fullName.toLowerCase() === altId.toLowerCase()
        );
        if (altRepo && altRepo.id !== matchedRepo?.id) {
          alternatives.push(altRepo);
        }
      }

      return {
        repo: matchedRepo,
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
        repo: null,
        confidence: "low",
        reasoning:
          "The repository classifier failed to run, so I couldn't auto-detect the repository. Please select a repository.",
        alternatives: repos.slice(0, 5),
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

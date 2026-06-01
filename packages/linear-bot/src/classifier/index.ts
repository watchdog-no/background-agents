/**
 * Repository classifier for the Linear bot.
 *
 * Delegates the LLM call to the control-plane `POST /classify` endpoint, which
 * holds the subscription OAuth credentials (and any API-key fallback). The bot
 * builds the prompt and matches the returned repo id against its own repo list.
 */

import type { Env, RepoConfig, ClassificationResult } from "../types";
import type { ClassifyRawResult, ClassifyErrorResponse } from "@open-inspect/shared";
import { getAvailableRepos, buildRepoDescriptions } from "./repos";
import { buildInternalAuthHeaders } from "../utils/internal";
import { createLogger } from "../logger";

const log = createLogger("classifier");

const DEFAULT_CLASSIFICATION_MODEL = "openai/gpt-5.4-mini";

/**
 * Build classification prompt from Linear issue context.
 */
async function buildClassificationPrompt(
  env: Env,
  issueTitle: string,
  issueDescription: string | null | undefined,
  labels: string[],
  projectName: string | null | undefined,
  teamName: string | null | undefined,
  teamKey: string | null | undefined,
  triggerComment: string | null | undefined,
  traceId?: string
): Promise<string> {
  const repoDescriptions = await buildRepoDescriptions(env, traceId);

  const escapeUntrusted = (s: string) =>
    s
      .replaceAll("</linear_comment>", "<\\/linear_comment>")
      .replaceAll("<linear_comment>", "<\\linear_comment>");

  let contextSection = "";
  if (teamName)
    contextSection += `\n**Team**: ${escapeUntrusted(teamName)}${teamKey ? ` (${escapeUntrusted(teamKey)})` : ""}`;
  if (labels.length > 0)
    contextSection += `\n**Labels**: ${labels.map(escapeUntrusted).join(", ")}`;
  if (projectName) contextSection += `\n**Project**: ${escapeUntrusted(projectName)}`;

  return `You are a repository classifier for a coding agent. Your job is to determine which code repository a Linear issue belongs to.

## Available Repositories
${repoDescriptions}

## Issue
**Title**: ${escapeUntrusted(issueTitle)}
${issueDescription ? `**Description**: ${escapeUntrusted(issueDescription)}` : ""}
${contextSection}${triggerComment ? `\n\n## User Comment\n<linear_comment>\n${escapeUntrusted(triggerComment)}\n</linear_comment>` : ""}

## Your Task

Analyze the issue to determine which repository it belongs to.

Consider:
1. Explicit mentions of repository names or aliases
2. Technical keywords that match repository technologies or languages
3. File paths or code patterns mentioned
4. The team name and what area of the codebase it likely owns
5. Project name associations
6. Label associations

Return your decision by calling the classify_repository tool.`;
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
 * Classify which repository a Linear issue belongs to.
 */
export async function classifyRepo(
  env: Env,
  issueTitle: string,
  issueDescription: string | null | undefined,
  labels: string[],
  projectName: string | null | undefined,
  teamName: string | null | undefined,
  teamKey: string | null | undefined,
  triggerComment: string | null | undefined,
  traceId?: string
): Promise<ClassificationResult> {
  const repos = await getAvailableRepos(env, traceId);

  if (repos.length === 0) {
    return {
      repo: null,
      confidence: "low",
      reasoning: "No repositories are currently available.",
      needsClarification: true,
    };
  }

  if (repos.length === 1) {
    return {
      repo: repos[0],
      confidence: "high",
      reasoning: "Only one repository is available.",
      needsClarification: false,
    };
  }

  try {
    const prompt = await buildClassificationPrompt(
      env,
      issueTitle,
      issueDescription,
      labels,
      projectName,
      teamName,
      teamKey,
      triggerComment,
      traceId
    );

    const model = env.CLASSIFICATION_MODEL || DEFAULT_CLASSIFICATION_MODEL;
    const result = await callClassifyEndpoint(env, prompt, model, traceId);

    let matchedRepo: RepoConfig | null = null;
    if (result.repoId) {
      matchedRepo =
        repos.find(
          (r) =>
            r.id.toLowerCase() === result.repoId!.toLowerCase() ||
            r.fullName.toLowerCase() === result.repoId!.toLowerCase()
        ) || null;
    }

    const alternatives: RepoConfig[] = [];
    for (const altId of result.alternatives) {
      const alt = repos.find(
        (r) =>
          r.id.toLowerCase() === altId.toLowerCase() ||
          r.fullName.toLowerCase() === altId.toLowerCase()
      );
      if (alt && alt.id !== matchedRepo?.id) alternatives.push(alt);
    }

    return {
      repo: matchedRepo,
      confidence: result.confidence,
      reasoning: result.reasoning,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      needsClarification:
        !matchedRepo ||
        result.confidence === "low" ||
        (result.confidence === "medium" && alternatives.length > 0),
    };
  } catch (e) {
    const failureReason =
      e instanceof ClassifierEndpointError ? (e.reason ?? "provider_error") : "provider_error";

    log.error("classifier.classify", {
      trace_id: traceId,
      outcome: "error",
      failure_reason: failureReason,
      error: e instanceof Error ? e : new Error(String(e)),
    });

    return {
      repo: null,
      confidence: "low",
      reasoning:
        "The repository classifier failed to run, so I couldn't auto-detect the repository. Please reply with the repository name (e.g., `owner/repo`).",
      alternatives: repos.slice(0, 5),
      needsClarification: true,
      failureReason,
    };
  }
}

/**
 * Pure functions for resolving models and repos from configuration + labels.
 */

import type { TeamRepoMapping, StaticTargetConfig } from "./types";
import {
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  type ValidModel,
} from "@open-inspect/shared/models";

/**
 * Resolve a target (repository or environment) from the static team mapping:
 * the first entry whose label matches an issue label, else the first
 * label-less entry.
 */
export function resolveStaticTarget(
  teamMapping: TeamRepoMapping,
  teamId: string,
  issueLabels?: string[]
): StaticTargetConfig | null {
  const targetConfigs = teamMapping[teamId];
  if (!targetConfigs || targetConfigs.length === 0) return null;

  const labelSet = new Set((issueLabels || []).map((l) => l.toLowerCase()));
  return (
    targetConfigs.find((t) => t.label && labelSet.has(t.label.toLowerCase())) ||
    targetConfigs.find((t) => !t.label) ||
    null
  );
}

const MODEL_LABEL_ALIASES = {
  haiku: "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  opus: "anthropic/claude-opus-4-5",
  "opus-4-6": "anthropic/claude-opus-4-6",
  "opus-4-7": "anthropic/claude-opus-4-7",
  "opus-4-8": "anthropic/claude-opus-4-8",
  "opus-5": "anthropic/claude-opus-5",
  "sonnet-5": "anthropic/claude-sonnet-5",
  // The bare alias tracks the newest Fable; pin a generation to hold one.
  fable: "anthropic/claude-fable-5-1",
  "fable-5": "anthropic/claude-fable-5",
  "fable-5-1": "anthropic/claude-fable-5-1",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.5-pro": "openai/gpt-5.5-pro",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-5.6-terra": "openai/gpt-5.6-terra",
  "gpt-5.6-luna": "openai/gpt-5.6-luna",
  astra: "openai/gpt-6-astra",
  "gpt-6-astra": "openai/gpt-6-astra",
  "gpt-6-sol": "openai/gpt-6-sol",
  "gpt-6-luna": "openai/gpt-6-luna",
  "gpt-5.3-codex": "openai/gpt-5.3-codex",
} satisfies Record<string, ValidModel>;

/**
 * Extract model override from issue labels (e.g., "model:opus" → "anthropic/claude-opus-4-5").
 */
export function extractModelFromLabels(labels: Array<{ name: string }>): ValidModel | null {
  for (const label of labels) {
    const match = label.name.match(/^model:(.+)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      const alias = MODEL_LABEL_ALIASES[key as keyof typeof MODEL_LABEL_ALIASES];
      if (alias) return alias;

      const candidate =
        key.startsWith("gpt-") || key.startsWith("claude-") || key.includes("/")
          ? key
          : `claude-${key}`;
      const normalized = normalizeModelId(candidate);
      if (isValidModel(normalized)) return normalized;
    }
  }
  return null;
}

export interface ResolveSessionModelInput {
  envDefaultModel: string;
  configModel: string | null;
  configReasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  userModel?: string;
  userReasoningEffort?: string;
  labelModel?: string | null;
}

export function resolveSessionModelSettings(input: ResolveSessionModelInput): {
  model: string;
  reasoningEffort: string | undefined;
} {
  let model = input.configModel ?? input.envDefaultModel;
  let modelSource: "config" | "env" | "user" | "label" = input.configModel ? "config" : "env";

  if (input.allowUserPreferenceOverride && input.userModel) {
    model = input.userModel;
    modelSource = "user";
  }

  if (input.allowLabelModelOverride && input.labelModel) {
    model = input.labelModel;
    modelSource = "label";
  }

  const normalizedModel = getValidModelOrDefault(model);

  if (
    input.allowUserPreferenceOverride &&
    input.userReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.userReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.userReasoningEffort };
  }

  if (
    modelSource !== "user" &&
    modelSource !== "label" &&
    input.configReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.configReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.configReasoningEffort };
  }

  return { model: normalizedModel, reasoningEffort: getDefaultReasoningEffort(normalizedModel) };
}

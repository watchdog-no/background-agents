import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  resolveEnabledModel,
} from "@open-inspect/shared/models";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

export function resolveModelPreference(
  preference: ModelPreference,
  enabledModels: string[] | undefined
): ModelPreference {
  const requestedModel = isValidModel(preference.model)
    ? normalizeModelId(preference.model)
    : undefined;
  const model = enabledModels
    ? resolveEnabledModel({
        model: preference.model,
        enabledModels,
        fallbackModel: DEFAULT_MODEL,
      })
    : getValidModelOrDefault(preference.model);
  return {
    model,
    reasoningEffort:
      requestedModel === model &&
      preference.reasoningEffort &&
      isValidReasoningEffort(model, preference.reasoningEffort)
        ? preference.reasoningEffort
        : getDefaultReasoningEffort(model),
  };
}

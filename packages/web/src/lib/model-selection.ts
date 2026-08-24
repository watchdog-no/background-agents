import {
  DEFAULT_MODEL,
  getReasoningConfig,
  getValidModelOrDefault,
  isValidModel,
  normalizeModelId,
  resolveEnabledModel,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

export interface ResolvedModelPreference {
  model: ValidModel;
  reasoningEffort?: ReasoningEffort;
}

export function resolveModelPreference(
  preference: ModelPreference,
  enabledModels: string[] | undefined
): ResolvedModelPreference {
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
  const reasoningConfig = getReasoningConfig(model);
  return {
    model,
    reasoningEffort:
      preference.reasoningEffort === undefined
        ? undefined
        : requestedModel === model
          ? (reasoningConfig?.efforts.find((effort) => effort === preference.reasoningEffort) ??
            reasoningConfig?.default)
          : reasoningConfig?.default,
  };
}

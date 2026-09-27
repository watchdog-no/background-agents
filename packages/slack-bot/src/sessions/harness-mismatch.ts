import {
  getHarnessLabel,
  harnessSupportsModel,
  resolveHarnessForModel,
} from "@open-inspect/shared/harnesses";

/**
 * A thread's session keeps the harness it was created on, and Anthropic models
 * run only on the Claude Agent harness. Say so plainly instead of letting the
 * control plane reject the prompt as a generic failure.
 */
export function followUpHarnessMismatch(sessionModel: string, nextModel: string): string | null {
  const harness = resolveHarnessForModel(null, sessionModel);
  if (harnessSupportsModel(harness, nextModel)) return null;
  return `This thread runs on ${getHarnessLabel(harness)}, which can't use \`${nextModel}\`. Start a new thread to use that model.`;
}

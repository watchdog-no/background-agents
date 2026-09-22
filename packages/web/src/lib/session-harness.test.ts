import { describe, expect, it } from "vitest";
import { type ModelCategory } from "@open-inspect/shared/models";
import { filterModelOptionsForHarness, resolveHarnessModelSelection } from "./session-harness";

const OPENAI_MODEL = "openai/gpt-5.4";
// Named by provider rather than taken from DEFAULT_MODEL: these cases turn on
// which harness can run the model, and a deployment is free to default to a
// model the Claude harness cannot.
const ANTHROPIC_MODEL = "anthropic/claude-sonnet-5";
const options: ModelCategory[] = [
  { category: "Anthropic", models: [{ id: ANTHROPIC_MODEL, name: "Sonnet 5", description: "" }] },
  { category: "OpenAI", models: [{ id: OPENAI_MODEL, name: "GPT-5.4", description: "" }] },
];

describe("filterModelOptionsForHarness", () => {
  it("drops groups the harness empties", () => {
    expect(filterModelOptionsForHarness("claude", options)).toEqual([options[0]]);
    expect(filterModelOptionsForHarness("opencode", options)).toEqual(options);
  });
});

describe("resolveHarnessModelSelection", () => {
  it("holds submission while the enabled set loads and keeps the preference for display", () => {
    const selection = resolveHarnessModelSelection({
      harness: "claude",
      preference: { model: OPENAI_MODEL },
      enabledModels: [],
      enabledModelOptions: [],
      loading: true,
    });
    expect(selection.availability).toEqual({ status: "loading" });
    expect(selection.model).toBe(OPENAI_MODEL);
  });

  it("resolves a preference the harness cannot run to an enabled model it can", () => {
    const selection = resolveHarnessModelSelection({
      harness: "claude",
      preference: { model: OPENAI_MODEL },
      enabledModels: [OPENAI_MODEL, ANTHROPIC_MODEL],
      enabledModelOptions: options,
      loading: false,
    });
    expect(selection.availability).toEqual({ status: "available" });
    expect(selection.model).toBe(ANTHROPIC_MODEL);
    expect(selection.options).toEqual([options[0]]);
  });

  it("reports an empty compatible set instead of falling back to a hidden model", () => {
    const selection = resolveHarnessModelSelection({
      harness: "claude",
      preference: { model: OPENAI_MODEL },
      enabledModels: [OPENAI_MODEL],
      enabledModelOptions: [options[1]],
      loading: false,
    });
    expect(selection.availability).toEqual({
      status: "unavailable",
      message: "No enabled models can run on Claude Agent.",
    });
    expect(selection.options).toEqual([]);
  });
});

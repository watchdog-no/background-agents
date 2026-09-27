import { describe, expect, it } from "vitest";
import { followUpHarnessMismatch } from "./harness-mismatch";

describe("followUpHarnessMismatch", () => {
  it("allows a follow-up model the thread's harness can run", () => {
    expect(followUpHarnessMismatch("openai/gpt-6-sol", "openai/gpt-5.5")).toBeNull();
    expect(
      followUpHarnessMismatch("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5")
    ).toBeNull();
  });

  it("explains a switch between the OpenCode and Claude Agent harnesses", () => {
    expect(followUpHarnessMismatch("openai/gpt-6-sol", "anthropic/claude-opus-5-5")).toBe(
      "This thread runs on OpenCode, which can't use `anthropic/claude-opus-5-5`. Start a new thread to use that model."
    );
    expect(followUpHarnessMismatch("anthropic/claude-opus-5-5", "openai/gpt-6-sol")).toContain(
      "This thread runs on Claude Agent"
    );
  });
});

import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { OPENAI_SUBSCRIPTION_MODEL_IDS } from "./models";

function readSandboxAllowedModels(): string[] {
  const source = readFileSync(
    new URL(
      "../../sandbox-runtime/src/sandbox_runtime/plugins/codex-auth-plugin.js",
      import.meta.url
    ),
    "utf8"
  );
  const file = ts.createSourceFile(
    "codex-auth-plugin.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  let models: string[] | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ALLOWED_MODELS" &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "Set"
    ) {
      const [argument] = node.initializer.arguments ?? [];
      if (argument && ts.isArrayLiteralExpression(argument)) {
        models = argument.elements.map((element) => {
          if (!ts.isStringLiteral(element)) {
            throw new Error("ALLOWED_MODELS must contain only string literals");
          }
          return element.text;
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);

  if (!models) {
    throw new Error("Could not find ALLOWED_MODELS in codex-auth-plugin.js");
  }

  return models;
}

describe("OPENAI_SUBSCRIPTION_MODEL_IDS", () => {
  it("matches the sandbox Codex auth plugin model allowlist", () => {
    const sharedModels = [...OPENAI_SUBSCRIPTION_MODEL_IDS].sort();
    const sandboxModels = readSandboxAllowedModels().sort();

    expect(new Set(sharedModels).size).toBe(sharedModels.length);
    expect(new Set(sandboxModels).size).toBe(sandboxModels.length);
    expect(sharedModels).toEqual(sandboxModels);
  });
});

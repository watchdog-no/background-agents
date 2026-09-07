import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

async function migrate() {
  const migration = env.TEST_MIGRATIONS.find(({ name }) => name === "9012_use_gpt_6_astra.sql");
  if (!migration) throw new Error("Astra migration missing");
  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
}

describe("Astra configuration migration", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM integration_settings; DELETE FROM model_preferences;");
  });

  it("migrates Sol defaults and unsupported none effort without changing other settings", async () => {
    const settings = {
      defaults: {
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "none",
        codeReviewInstructions: "Retain this text",
      },
    };
    await env.DB.prepare(
      "INSERT INTO integration_settings (integration_id, settings, created_at, updated_at) VALUES ('github', ?, 1, 1)"
    )
      .bind(JSON.stringify(settings))
      .run();
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, 1)"
    )
      .bind(JSON.stringify(["openai/gpt-5.6-sol", "openai/gpt-6-astra"]))
      .run();
    await migrate();
    await migrate();
    const row = await env.DB.prepare(
      "SELECT settings FROM integration_settings WHERE integration_id = 'github'"
    ).first<{ settings: string }>();
    expect(JSON.parse(row!.settings)).toEqual({
      defaults: { ...settings.defaults, model: "openai/gpt-6-astra", reasoningEffort: "medium" },
    });
    const catalog = await env.DB.prepare(
      "SELECT enabled_models FROM model_preferences WHERE id = 'global'"
    ).first<{ enabled_models: string }>();
    expect(JSON.parse(catalog!.enabled_models)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-6-astra",
    ]);
  });

  it("preserves unrelated model defaults and adds Astra once", async () => {
    const settings = { defaults: { model: "openai/gpt-5.6-luna", reasoningEffort: "none" } };
    await env.DB.prepare(
      "INSERT INTO integration_settings (integration_id, settings, created_at, updated_at) VALUES ('linear', ?, 1, 1)"
    )
      .bind(JSON.stringify(settings))
      .run();
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, 1)"
    )
      .bind(JSON.stringify(["openai/gpt-5.6-luna"]))
      .run();
    await migrate();
    await migrate();
    const row = await env.DB.prepare(
      "SELECT settings FROM integration_settings WHERE integration_id = 'linear'"
    ).first<{ settings: string }>();
    expect(JSON.parse(row!.settings)).toEqual(settings);
    const catalog = await env.DB.prepare(
      "SELECT enabled_models FROM model_preferences WHERE id = 'global'"
    ).first<{ enabled_models: string }>();
    expect(JSON.parse(catalog!.enabled_models)).toEqual([
      "openai/gpt-5.6-luna",
      "openai/gpt-6-astra",
    ]);
  });
});

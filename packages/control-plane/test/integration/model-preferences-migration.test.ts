import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

const MIGRATION_NAME = "9006_enable_gpt_5_6_models.sql";

function migrationQueries(): string[] {
  const migration = env.TEST_MIGRATIONS.find(({ name }) => name === MIGRATION_NAME);
  expect(migration, `${MIGRATION_NAME} should be loaded`).toBeDefined();
  return migration!.queries;
}

async function applyMigration(): Promise<void> {
  await env.DB.batch(migrationQueries().map((query) => env.DB.prepare(query)));
}

async function readEnabledModels(): Promise<string[] | null> {
  const row = await env.DB.prepare(
    "SELECT enabled_models FROM model_preferences WHERE id = 'global'"
  ).first<{ enabled_models: string }>();
  return row ? (JSON.parse(row.enabled_models) as string[]) : null;
}

describe("GPT-5.6 model-preferences migration", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM model_preferences");
  });

  it("adds missing variants without duplicating an already-enabled model", async () => {
    await env.DB.prepare(
      "INSERT INTO model_preferences (id, enabled_models, updated_at) VALUES ('global', ?, 1)"
    )
      .bind(JSON.stringify(["openai/gpt-5.5", "openai/gpt-5.6-sol"]))
      .run();

    await applyMigration();

    expect(await readEnabledModels()).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ]);

    await applyMigration();
    expect(await readEnabledModels()).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ]);
  });

  it("does not create preferences when the deployment has never saved them", async () => {
    await applyMigration();

    expect(await readEnabledModels()).toBeNull();
  });
});

import path from "path";
import { defineConfig } from "vitest/config";
import { coverageExclusions, coverageThresholds } from "../../scripts/coverage-policy";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Node 25+ ships a global localStorage that is undefined without
    // --localstorage-file and shadows jsdom's, so jsdom tests see no storage.
    execArgv: ["--no-experimental-webstorage"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: coverageExclusions("web"),
      thresholds: coverageThresholds("web"),
    },
  },
});

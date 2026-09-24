import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  outputDir: "../test-results",
  // VS Code download and first launch dominate the run time.
  timeout: 180_000,
  workers: 1,
  reporter: [["list"]],
});

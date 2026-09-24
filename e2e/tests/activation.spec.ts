import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const extensionPath = path.resolve(__dirname, "../../packages/extension");
const workspacePath = path.resolve(__dirname, "../fixtures/workspace");

test("Fusen activates in VS Code", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  const app = await electron.launch({
    executablePath: await downloadAndUnzipVSCode("stable"),
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--extensionDevelopmentPath=${extensionPath}`,
      `--extensions-dir=${path.join(profilePath, "extensions")}`,
      `--user-data-dir=${path.join(profilePath, "user-data")}`,
      workspacePath,
      path.join(workspacePath, "sample.ts"),
    ],
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });
    await window.screenshot({ path: testInfo.outputPath("activation.png") });
  } finally {
    await app.close();
  }
});

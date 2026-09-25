import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchVSCode, vscodeStartupTimeoutMs } from "../launch";

const workspacePath = path.resolve(__dirname, "../fixtures/workspace");

test("Fusen activates in VS Code", async ({}, testInfo) => {
  const app = await launchVSCode({
    profilePath: mkdtempSync(path.join(tmpdir(), "fusen-e2e-")),
    workspacePath,
    filePath: path.join(workspacePath, "sample.ts"),
  });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    // The editor can be switched with FUSEN_E2E_EXECUTABLE_PATH, so the job log records which build ran.
    console.log(`Editor: ${await app.evaluate(({ app }) => `${app.getName()} ${app.getVersion()}`)}`);
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });
    await window.screenshot({ path: testInfo.outputPath("activation.png") });
  } finally {
    await app.close();
  }
});

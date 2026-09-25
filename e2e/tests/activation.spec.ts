import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchVSCode } from "../launch";

const workspacePath = path.resolve(__dirname, "../fixtures/workspace");

test("Fusen activates in VS Code", async ({}, testInfo) => {
  const app = await launchVSCode({
    profilePath: mkdtempSync(path.join(tmpdir(), "fusen-e2e-")),
    workspacePath,
    filePath: path.join(workspacePath, "sample.ts"),
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });
    await window.screenshot({ path: testInfo.outputPath("activation.png") });
  } finally {
    await app.close();
  }
});

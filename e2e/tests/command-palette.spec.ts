import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { runCommand } from "../command-palette";
import { launchVSCode, vscodeStartupTimeoutMs } from "../launch";

const workspacePath = path.resolve(__dirname, "../fixtures/workspace");

// Exercises the runCommand helper with a built-in command so that the helper stays working
// independently of which commands Fusen contributes to the palette.
test("runCommand drives the command palette", async ({}, testInfo) => {
  const app = await launchVSCode({
    profilePath: mkdtempSync(path.join(tmpdir(), "fusen-e2e-")),
    workspacePath,
    filePath: path.join(workspacePath, "sample.ts"),
  });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    // The status bar item is created in `activate`, so its presence means the workbench is ready for commands.
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });
    await runCommand(window, "Go to Line/Column...");
    await window.keyboard.type("5");
    await window.keyboard.press("Enter");
    await expect(window.locator(".statusbar-item", { hasText: "Ln 5, Col 1" })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("command-palette.png") });
  } finally {
    await app.close();
  }
});

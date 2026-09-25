import { expect, test } from "@playwright/test";
import { launchVSCode, runCommand } from "../helpers/vscode";

// Exercises the runCommand helper with a built-in command so that the helper stays working
// before Fusen contributes commands of its own.
test("runCommand drives the command palette", async ({}, testInfo) => {
  const { app, window } = await launchVSCode("sample.ts");
  try {
    await runCommand(window, "Go to Line/Column...");
    await window.keyboard.type("5");
    await window.keyboard.press("Enter");
    await expect(window.locator(".statusbar-item", { hasText: "Ln 5, Col 1" })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("command-palette.png") });
  } finally {
    await app.close();
  }
});

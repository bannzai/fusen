import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const extensionPath = path.resolve(__dirname, "../../packages/extension");

/** Directory of the workspace that every E2E test opens. */
export const workspacePath = path.resolve(__dirname, "../fixtures/workspace");

/** A running VS Code instance with the Fusen extension loaded from source. */
export interface VSCodeSession {
  /** The Electron application, closed by the caller when the test ends. */
  app: ElectronApplication;
  /** The first workbench window. */
  window: Page;
}

/**
 * Launches VS Code stable with Fusen as a development extension, opening the fixture workspace and
 * `openFile` (relative to it) in an editor, and waits until Fusen has activated.
 * Each launch uses a fresh profile so that no state leaks between tests.
 */
export async function launchVSCode(openFile: string): Promise<VSCodeSession> {
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
      path.join(workspacePath, openFile),
    ],
  });
  const window = await app.firstWindow();
  // The status bar item is created in `activate`, so its presence means the extension host is ready for commands.
  // 60 seconds covers the first launch on a CI runner, which is dominated by VS Code start-up.
  await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });
  return { app, window };
}

/**
 * Runs a command from the command palette by its title as shown in the palette (for example "Go to Line/Column...").
 * The palette runs its top match, so pass the full title. Resolves right after pressing Enter;
 * the caller waits for the command's effect.
 */
export async function runCommand(window: Page, commandTitle: string): Promise<void> {
  const quickInput = window.locator(".quick-input-widget");
  await window.keyboard.press("F1");
  await expect(quickInput).toBeVisible();
  // F1 opens the palette with the ">" command prefix already typed.
  await quickInput.locator("input").fill(`>${commandTitle}`);
  await expect(quickInput.getByRole("option", { name: commandTitle, exact: false }).first()).toBeVisible();
  await window.keyboard.press("Enter");
}

import path from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const extensionPath = path.resolve(__dirname, "../packages/extension");

// Playwright's default of 30 seconds is not always enough for VS Code to start on a slow CI runner.
// 120 seconds stays inside the 180-second budget of a single-launch test in playwright.config.ts.
export const vscodeStartupTimeoutMs = 120_000;

/**
 * Launches VS Code with the Fusen extension under development and opens `workspacePath` and `filePath`.
 * Launches that share `profilePath` share user data and extensions, like restarts of the same installation.
 * When `FUSEN_E2E_EXECUTABLE_PATH` is set, the editor at that path (for example Cursor, which runs the same
 * workbench and extension host) is launched instead; otherwise VS Code stable is downloaded and launched.
 */
export async function launchVSCode({
  profilePath,
  workspacePath,
  filePath,
}: {
  profilePath: string;
  workspacePath: string;
  filePath: string;
}): Promise<ElectronApplication> {
  return electron.launch({
    // VS Code stable is the editor Fusen is built against, so it is what the tests run in unless another is chosen.
    executablePath: process.env.FUSEN_E2E_EXECUTABLE_PATH || (await downloadAndUnzipVSCode("stable")),
    timeout: vscodeStartupTimeoutMs,
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      // Cursor's flag for skipping its log-in onboarding, which otherwise covers the workbench and takes every click.
      // VS Code ignores the unknown flag.
      "--skip-onboarding",
      `--extensionDevelopmentPath=${extensionPath}`,
      `--extensions-dir=${path.join(profilePath, "extensions")}`,
      `--user-data-dir=${path.join(profilePath, "user-data")}`,
      workspacePath,
      filePath,
    ],
  });
}

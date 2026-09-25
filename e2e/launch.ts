import path from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const extensionPath = path.resolve(__dirname, "../packages/extension");

/**
 * Launches VS Code with the Fusen extension under development and opens `workspacePath` and `filePath`.
 * Launches that share `profilePath` share user data and extensions, like restarts of the same installation.
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
      filePath,
    ],
  });
}

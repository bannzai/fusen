import { execFileSync } from "node:child_process";
import path from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const extensionPath = path.resolve(__dirname, "../packages/extension");

// Playwright's default of 30 seconds is not always enough for VS Code to start on a slow CI runner.
// 120 seconds stays inside the 180-second budget of a single-launch test in playwright.config.ts.
export const vscodeStartupTimeoutMs = 120_000;

/**
 * Launches VS Code with the Fusen extension and opens `workspacePath` and `filePath`.
 * Launches that share `profilePath` share user data and extensions, like restarts of the same installation.
 * When `FUSEN_E2E_EXECUTABLE_PATH` is set, the editor at that path (for example Cursor, which runs the same
 * workbench and extension host) is launched instead; otherwise VS Code stable is downloaded and launched.
 * When `FUSEN_E2E_VSIX_PATH` is set, the VSIX at that path is installed into the profile's extensions directory and
 * the editor runs the installed extension, as a user who installed the VSIX does; otherwise it loads the extension
 * from `packages/extension` as an extension under development.
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
  // VS Code stable is the editor Fusen is built against, so it is what the tests run in unless another is chosen.
  const executablePath = process.env.FUSEN_E2E_EXECUTABLE_PATH || (await downloadAndUnzipVSCode("stable"));
  const profileArgs = [
    `--extensions-dir=${path.join(profilePath, "extensions")}`,
    `--user-data-dir=${path.join(profilePath, "user-data")}`,
  ];
  const vsixPath = process.env.FUSEN_E2E_VSIX_PATH;
  if (vsixPath) {
    installVsix({ executablePath, vsixPath, profileArgs });
  }
  return electron.launch({
    executablePath,
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
      ...(vsixPath ? [] : [`--extensionDevelopmentPath=${extensionPath}`]),
      ...profileArgs,
      workspacePath,
      filePath,
    ],
  });
}

/**
 * Installs the VSIX at `vsixPath` with the command-line interface of the editor at `executablePath`, into the
 * extensions directory named in `profileArgs`. `--force` reinstalls a VSIX that a previous launch of the same
 * profile already installed, so repeated calls leave the same installation.
 */
function installVsix({
  executablePath,
  vsixPath,
  profileArgs,
}: {
  executablePath: string;
  vsixPath: string;
  profileArgs: string[];
}): void {
  // The Linux builds of VS Code and Cursor keep their command-line interface, the one users run as `code` or `cursor`,
  // in `bin/` next to the Electron binary under the binary's name.
  const cliPath = path.join(path.dirname(executablePath), "bin", path.basename(executablePath));
  console.log(
    execFileSync(cliPath, ["--install-extension", path.resolve(vsixPath), "--force", ...profileArgs], { encoding: "utf8" }),
  );
}

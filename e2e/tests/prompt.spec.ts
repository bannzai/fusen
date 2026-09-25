import { cpSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, type Page, expect, test } from "@playwright/test";
import { createPrompt, promptFilePath, readThreads, writeThread } from "fusen-core";
import { launchVSCode, vscodeStartupTimeoutMs } from "../launch";
import { addNote } from "../notes";

const fixtureWorkspacePath = path.resolve(__dirname, "../fixtures/workspace");

/** Runs the command titled `commandTitle` from the command palette and picks `scopeLabel` in the scope pick it opens. */
async function runPromptCommand(window: Page, commandTitle: string, scopeLabel: string): Promise<void> {
  const quickInput = window.locator(".quick-input-widget");
  await window.keyboard.press("F1");
  await expect(quickInput).toBeVisible();
  // F1 opens the palette with the ">" command prefix already typed.
  await quickInput.locator("input").fill(`>${commandTitle}`);
  await expect(quickInput.getByRole("option", { name: commandTitle }).first()).toBeVisible();
  await window.keyboard.press("Enter");
  await quickInput.getByRole("option", { name: scopeLabel }).click();
}

/** Returns the text on the system clipboard of the VS Code instance `app`. */
function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

test("comments are copied and exported as one markdown prompt, for the current file or for all files", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  // A copy keeps the `.fusen/` the test writes out of the repository's fixture.
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  // A thread on another file tells the current-file prompt apart from the prompt of all files.
  await writeFile(path.join(workspacePath, "other.ts"), "export const answer = 42;\n", "utf8");
  await writeThread(workspacePath, {
    version: 1,
    id: "other-thread",
    file: "other.ts",
    startLine: 1,
    endLine: 1,
    comments: [{ id: "other", body: "Explain this constant", author: "human", createdAt: new Date().toISOString() }],
  });

  const app = await launchVSCode({ profilePath, workspacePath, filePath: path.join(workspacePath, "sample.ts") });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });

    // The lower line first, so the thread widget opened below it does not move the upper line.
    await addNote(window, "return a + b;", "Rename add to sum");
    await addNote(window, "return `Hello, ${name}`;", "Greet in Japanese");
    await expect.poll(async () => (await readThreads(workspacePath)).threads.length).toBe(3);
    const { threads } = await readThreads(workspacePath);
    const sampleThreads = threads.filter((thread) => thread.file === "sample.ts");
    expect(sampleThreads.map((thread) => thread.startLine).sort()).toEqual([2, 6]);

    await runPromptCommand(window, "Fusen: Copy comments as prompt", "Comments in the current file");
    await expect.poll(() => readClipboard(app)).toBe(await createPrompt(workspacePath, sampleThreads));
    const currentFilePrompt = await readClipboard(app);
    expect(currentFilePrompt).toContain("2 comment threads on 1 file.");
    expect(currentFilePrompt).not.toContain("Explain this constant");
    await expect(window.locator(".notification-toast", { hasText: "Fusen copied 2 threads as a prompt" })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("prompt-copied.png") });

    await runPromptCommand(window, "Fusen: Export comments as prompt to .fusen/prompt.md", "All comments");
    await expect.poll(() => readFile(promptFilePath(workspacePath), "utf8").catch(() => "")).not.toBe("");
    const exportedPrompt = await readFile(promptFilePath(workspacePath), "utf8");
    expect(exportedPrompt).toBe(await createPrompt(workspacePath, threads));
    expect(exportedPrompt).toContain(
      [
        "## other.ts:1",
        "```ts\nexport const answer = 42;\n```",
        "**Human:**\n\nExplain this constant",
        "## sample.ts:2",
        "```ts\n  return `Hello, ${name}`;\n```",
        "**Human:**\n\nGreet in Japanese",
        "## sample.ts:6",
        "```ts\n  return a + b;\n```",
        "**Human:**\n\nRename add to sum",
      ].join("\n\n"),
    );
    // The command opens the exported file, so the screenshot shows the prompt.
    await expect(window.locator(".tab.active", { hasText: "prompt.md" })).toBeVisible();
    await expect(window.locator(".view-line", { hasText: "# Fusen comments" })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("prompt-exported.png") });
  } finally {
    await app.close();
  }
});

import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readThreads, writeThread } from "fusen-core";
import { launchVSCode, vscodeStartupTimeoutMs } from "../launch";

const fixtureWorkspacePath = path.resolve(__dirname, "../fixtures/workspace");

test("comment authors are shown with the names in fusen.humanName and fusen.agentName, and follow changes to them", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  // A copy keeps the `.fusen/` and `.vscode/` the test writes out of the repository's fixture.
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  mkdirSync(path.join(workspacePath, ".vscode"));
  const writeSettings = (settings: Record<string, string>) =>
    writeFile(path.join(workspacePath, ".vscode", "settings.json"), JSON.stringify(settings));
  await writeSettings({ "fusen.humanName": "Octocat" });
  await writeThread(workspacePath, {
    version: 1,
    id: "e2e-thread",
    file: "sample.ts",
    startLine: 6,
    endLine: 6,
    code: ["  return a + b;"],
    comments: [{ id: "first", body: "Rename add to sum", author: "agent", createdAt: new Date().toISOString() }],
  });

  const app = await launchVSCode({ profilePath, workspacePath, filePath: path.join(workspacePath, "sample.ts") });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    const reviewWidget = window.locator(".review-widget", { hasText: "Rename add to sum" });
    await expect(reviewWidget).toBeVisible({ timeout: 60_000 });
    const agentComment = reviewWidget.locator(".review-comment", { hasText: "Rename add to sum" });
    // `fusen.agentName` is not set, so the agent's comment keeps the name shown before the settings existed.
    await expect(agentComment).toContainText("Agent");

    // The reply box of a restored thread is either collapsed behind a prompt button that expands and focuses it,
    // or already expanded, depending on how the widget got focus while VS Code restored the editor.
    await reviewWidget
      .locator(".review-thread-reply-button")
      .or(reviewWidget.locator(".comment-form .monaco-editor"))
      .filter({ visible: true })
      .first()
      .click();
    await expect(reviewWidget.locator(".comment-form .monaco-editor")).toBeVisible();
    await window.keyboard.type("Done in the next commit");
    await reviewWidget.getByRole("button", { name: "Reply" }).click();
    const humanComment = reviewWidget.locator(".review-comment", { hasText: "Done in the next commit" });
    await expect(humanComment).toContainText("Octocat");
    await expect(humanComment).not.toContainText("Human");
    // The names are only shown; the stored authors stay `agent` and `human`.
    await expect
      .poll(async () => (await readThreads(workspacePath)).threads[0]?.comments.map((comment) => comment.author))
      .toEqual(["agent", "human"]);
    await window.screenshot({ path: testInfo.outputPath("author-names-from-settings.png") });

    await writeSettings({ "fusen.humanName": "", "fusen.agentName": "Claude" });
    // VS Code reads the changed settings file through its file watcher, which can take a few seconds on a CI runner.
    await expect(agentComment).toContainText("Claude", { timeout: 30_000 });
    await expect(humanComment).toContainText("Human");
    await expect(humanComment).not.toContainText("Octocat");
    await window.screenshot({ path: testInfo.outputPath("author-names-changed.png") });

    // A comment being edited when the name changes shows the new name once the edit ends.
    await humanComment.hover();
    await humanComment.getByRole("button", { name: "Edit" }).click();
    await expect(humanComment.locator(".edit-container .monaco-editor")).toBeVisible();
    await writeSettings({ "fusen.humanName": "Octocat", "fusen.agentName": "Codex" });
    // The agent's comment showing its new name tells that the change reached the extension while the other comment was being edited.
    await expect(agentComment).toContainText("Codex", { timeout: 30_000 });
    await humanComment.getByRole("button", { name: "Cancel" }).click();
    await expect(humanComment).toContainText("Octocat");
    await window.screenshot({ path: testInfo.outputPath("author-names-after-edit.png") });
  } finally {
    await app.close();
  }
});

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readThreads } from "fusen-core";
import { launchVSCode } from "../launch";

const fixtureWorkspacePath = path.resolve(__dirname, "../fixtures/workspace");

test("a note added from the gutter is saved to .fusen/ and restored after a restart", async ({}, testInfo) => {
  // Two VS Code launches run in this test, so it gets twice the per-launch budget of the config.
  test.setTimeout(360_000);
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  // A copy keeps the `.fusen/` the test writes out of the repository's fixture.
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  const launchOptions = { profilePath, workspacePath, filePath: path.join(workspacePath, "sample.ts") };
  const noteText = "Rename add to sum";

  const firstApp = await launchVSCode(launchOptions);
  try {
    const window = await firstApp.firstWindow();
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });

    // The gutter glyph column is shared by all lines, so click it at the height of the target line.
    const targetLine = window.locator(".view-line", { hasText: "return a + b;" });
    const gutterGlyph = window.locator(".margin-view-overlays .comment-range-glyph").first();
    await expect(targetLine).toBeVisible({ timeout: 30_000 });
    await expect(gutterGlyph).toBeAttached({ timeout: 30_000 });
    const targetLineBox = await targetLine.boundingBox();
    const gutterGlyphBox = await gutterGlyph.boundingBox();
    if (!targetLineBox || !gutterGlyphBox) {
      throw new Error("The target line or the gutter glyph is not rendered");
    }
    await window.mouse.move(gutterGlyphBox.x + gutterGlyphBox.width / 2, targetLineBox.y + targetLineBox.height / 2);
    await window.mouse.down();
    await window.mouse.up();

    const reviewWidget = window.locator(".review-widget");
    await reviewWidget.locator(".comment-form .monaco-editor").click();
    await window.keyboard.type(noteText);
    await reviewWidget.getByRole("button", { name: "Add Note" }).click();
    await expect(reviewWidget.locator(".comment-body", { hasText: noteText })).toBeVisible();

    await expect.poll(async () => (await readThreads(workspacePath)).threads.length).toBe(1);
    const { threads, invalidFiles } = await readThreads(workspacePath);
    expect(invalidFiles).toEqual([]);
    expect(threads[0]).toMatchObject({
      file: "sample.ts",
      startLine: 6,
      endLine: 6,
      comments: [{ body: noteText, author: "human" }],
    });
    await window.screenshot({ path: testInfo.outputPath("thread-added.png") });
  } finally {
    await firstApp.close();
  }

  const secondApp = await launchVSCode(launchOptions);
  try {
    const window = await secondApp.firstWindow();
    await expect(window.locator(".review-widget .comment-body", { hasText: noteText })).toBeVisible({ timeout: 60_000 });
    await window.screenshot({ path: testInfo.outputPath("thread-restored.png") });
  } finally {
    await secondApp.close();
  }
});

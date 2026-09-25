import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readThreads, writeThread } from "fusen-core";
import { launchVSCode, vscodeStartupTimeoutMs } from "../launch";
import { addNote } from "../notes";

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
    const window = await firstApp.firstWindow({ timeout: vscodeStartupTimeoutMs });
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });

    await addNote(window, "return a + b;", noteText);

    await expect.poll(async () => (await readThreads(workspacePath)).threads.length).toBe(1);
    const { threads, invalidFiles } = await readThreads(workspacePath);
    expect(invalidFiles).toEqual([]);
    expect(threads[0]).toMatchObject({
      file: "sample.ts",
      startLine: 6,
      endLine: 6,
      code: ["  return a + b;"],
      comments: [{ body: noteText, author: "human" }],
    });
    await window.screenshot({ path: testInfo.outputPath("thread-added.png") });
  } finally {
    await firstApp.close();
  }

  const secondApp = await launchVSCode(launchOptions);
  try {
    const window = await secondApp.firstWindow({ timeout: vscodeStartupTimeoutMs });
    await expect(window.locator(".review-widget .comment-body", { hasText: noteText })).toBeVisible({ timeout: 60_000 });
    await window.screenshot({ path: testInfo.outputPath("thread-restored.png") });
  } finally {
    await secondApp.close();
  }
});

test("a note added in a git repository records the commit and the state of the file", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fusen Test", "-c", "user.email=fusen@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd: workspacePath, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
    ).trimEnd();
  git(["init", "--initial-branch=main"]);
  git(["add", "."]);
  git(["commit", "-m", "Initial commit"]);
  // A change below the noted line that is not committed, so the note is posted on a file with unstaged changes.
  const filePath = path.join(workspacePath, "sample.ts");
  await writeFile(filePath, `${await readFile(filePath, "utf8")}// Not committed\n`, "utf8");
  const noteText = "Rename add to sum";

  const app = await launchVSCode({ profilePath, workspacePath, filePath });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });

    await addNote(window, "return a + b;", noteText);

    await expect.poll(async () => (await readThreads(workspacePath)).threads.length).toBe(1);
    const { threads, invalidFiles } = await readThreads(workspacePath);
    expect(invalidFiles).toEqual([]);
    expect(threads[0]?.comments).toEqual([
      expect.objectContaining({
        body: noteText,
        author: "human",
        git: { commit: git(["rev-parse", "HEAD"]), branch: "main", staged: false, unstaged: true, untracked: false },
      }),
    ]);
    await window.screenshot({ path: testInfo.outputPath("thread-added-in-git-repository.png") });
  } finally {
    await app.close();
  }
});

test("a note stays on its code when a line is inserted above it and the file is saved", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  const filePath = path.join(workspacePath, "sample.ts");
  const noteText = "Rename add to sum";
  await writeThread(workspacePath, {
    version: 1,
    id: "e2e-thread",
    file: "sample.ts",
    startLine: 6,
    endLine: 6,
    code: ["  return a + b;"],
    comments: [{ id: "first", body: noteText, author: "human", createdAt: new Date().toISOString() }],
  });

  const app = await launchVSCode({ profilePath, workspacePath, filePath });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    const reviewWidget = window.locator(".review-widget", { hasText: noteText });
    await expect(reviewWidget).toBeVisible({ timeout: 60_000 });

    // A line break at the start of the line above the function inserts an empty line without auto-indentation.
    await window.locator(".view-line", { hasText: "export function add" }).click();
    await window.keyboard.press("Home");
    await window.keyboard.press("Enter");
    await window.keyboard.press("ControlOrMeta+S");

    await expect
      .poll(async () => (await readFile(filePath, "utf8")).split("\n")[6])
      .toBe("  return a + b;");
    await expect
      .poll(async () => (await readThreads(workspacePath)).threads[0])
      .toMatchObject({ startLine: 7, endLine: 7, code: ["  return a + b;"] });

    // The thread widget is shown right below the last line of its range, so it must sit below the moved code, not above it.
    const targetLine = window.locator(".view-line", { hasText: "return a + b;" });
    await expect
      .poll(async () => {
        const targetLineBox = await targetLine.boundingBox();
        const reviewWidgetBox = await reviewWidget.boundingBox();
        return targetLineBox && reviewWidgetBox ? reviewWidgetBox.y - (targetLineBox.y + targetLineBox.height) : undefined;
      })
      .toBeGreaterThanOrEqual(-1);
    await window.screenshot({ path: testInfo.outputPath("thread-followed-code.png") });
  } finally {
    await app.close();
  }
});

test("replies, comment edits and deletions in a thread are saved to .fusen/", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  await writeThread(workspacePath, {
    version: 1,
    id: "e2e-thread",
    file: "sample.ts",
    startLine: 2,
    endLine: 2,
    comments: [{ id: "first", body: "Use a template literal", author: "human", createdAt: new Date().toISOString() }],
  });
  const readComments = async () => (await readThreads(workspacePath)).threads[0]?.comments;

  const app = await launchVSCode({ profilePath, workspacePath, filePath: path.join(workspacePath, "sample.ts") });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    const reviewWidget = window.locator(".review-widget", { hasText: "Use a template literal" });
    await expect(reviewWidget).toBeVisible({ timeout: 60_000 });

    // The reply box of a restored thread is either collapsed behind a prompt button that expands and focuses it,
    // or already expanded, depending on how the widget got focus while VS Code restored the editor.
    await reviewWidget
      .locator(".review-thread-reply-button")
      .or(reviewWidget.locator(".comment-form .monaco-editor"))
      .filter({ visible: true })
      .first()
      .click();
    await expect(reviewWidget.locator(".comment-form .monaco-editor")).toBeVisible();
    await window.keyboard.type("Already done");
    await reviewWidget.getByRole("button", { name: "Reply" }).click();
    await expect
      .poll(async () => (await readComments())?.map((comment) => comment.body))
      .toEqual(["Use a template literal", "Already done"]);

    const firstComment = reviewWidget.locator(".review-comment", { hasText: "Use a template literal" });
    await firstComment.hover();
    await firstComment.getByRole("button", { name: "Edit" }).click();
    await firstComment.locator(".edit-container .monaco-editor").click();
    await window.keyboard.press("ControlOrMeta+A");
    await window.keyboard.type("Use a template literal here");
    await firstComment.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(async () => (await readComments())?.map((comment) => comment.body))
      .toEqual(["Use a template literal here", "Already done"]);
    await expect(reviewWidget.locator(".comment-body", { hasText: "Use a template literal here" })).toBeVisible();
    await window.screenshot({ path: testInfo.outputPath("thread-replied-and-edited.png") });

    // Starting to edit another comment re-renders the thread; the unsaved text of the first edit must survive it.
    const reply = reviewWidget.locator(".review-comment", { hasText: "Already done" });
    await firstComment.hover();
    await firstComment.getByRole("button", { name: "Edit" }).click();
    await firstComment.locator(".edit-container .monaco-editor").click();
    await window.keyboard.press("ControlOrMeta+A");
    await window.keyboard.type("Unsaved draft");
    await reply.hover();
    await reply.getByRole("button", { name: "Edit" }).click();
    await expect(reply.locator(".edit-container .monaco-editor")).toBeVisible();
    await expect(firstComment.locator(".edit-container .monaco-editor")).toContainText("Unsaved draft");
    await firstComment.getByRole("button", { name: "Cancel" }).click();
    await reply.getByRole("button", { name: "Cancel" }).click();
    await expect(reviewWidget.locator(".comment-body", { hasText: "Use a template literal here" })).toBeVisible();
    expect((await readComments())?.map((comment) => comment.body)).toEqual(["Use a template literal here", "Already done"]);

    await reply.hover();
    await reply.getByRole("button", { name: "Delete", exact: true }).click();
    await expect
      .poll(async () => (await readComments())?.map((comment) => comment.body))
      .toEqual(["Use a template literal here"]);

    await reviewWidget.getByRole("button", { name: "Delete Thread" }).click();
    await expect.poll(async () => (await readThreads(workspacePath)).threads).toEqual([]);
    await expect(window.locator(".review-widget")).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("thread-deleted.png") });
  } finally {
    await app.close();
  }
});

import { expect, type Page } from "@playwright/test";

/** Adds a note with `noteText` from the gutter on the line of the open editor that contains `lineText`. */
export async function addNote(window: Page, lineText: string, noteText: string): Promise<void> {
  // The gutter glyph column is shared by all lines, so click it at the height of the target line.
  const targetLine = window.locator(".view-line", { hasText: lineText });
  // Glyphs of lines being re-rendered can be attached without a box, so wait for one that is laid out.
  const gutterGlyph = window.locator(".margin-view-overlays .comment-range-glyph").filter({ visible: true }).first();
  await expect(targetLine).toBeVisible({ timeout: 30_000 });
  await expect(gutterGlyph).toBeVisible({ timeout: 30_000 });
  // The editor re-renders its lines and gutter each time it reads the comment threads, which happens several times
  // around startup, so an element found visible can be gone when its box is read. Both boxes are read again until
  // they are read together. Each read gives up after a few seconds, so that one attempt cannot use up the whole wait.
  let clickPoint = { x: 0, y: 0 };
  await expect(async () => {
    const targetLineBox = await targetLine.boundingBox({ timeout: 5_000 });
    const gutterGlyphBox = await gutterGlyph.boundingBox({ timeout: 5_000 });
    if (!targetLineBox || !gutterGlyphBox) {
      throw new Error("The target line or the gutter glyph is not rendered");
    }
    clickPoint = { x: gutterGlyphBox.x + gutterGlyphBox.width / 2, y: targetLineBox.y + targetLineBox.height / 2 };
  }).toPass({ timeout: 30_000 });
  await window.mouse.move(clickPoint.x, clickPoint.y);
  await window.mouse.down();
  await window.mouse.up();

  // The new thread is the widget without comments; threads added before it are open too.
  const newThreadWidget = window.locator(".review-widget").filter({ hasNot: window.locator(".review-comment") });
  await newThreadWidget.locator(".comment-form .monaco-editor").click();
  await window.keyboard.type(noteText);
  await newThreadWidget.getByRole("button", { name: "Add Note" }).click();
  await expect(window.locator(".review-widget .comment-body", { hasText: noteText })).toBeVisible();
}

import { expect, type Page } from "@playwright/test";

/**
 * Runs a command from the command palette by its title as shown in the palette (for example "Go to Line/Column...").
 * The palette runs its top match, so pass the full title. Resolves right after pressing Enter;
 * the caller waits for the command's effect.
 */
export async function runCommand(window: Page, commandTitle: string): Promise<void> {
  const quickInput = window.locator(".quick-input-widget");
  await window.keyboard.press("F1");
  await expect(quickInput).toBeVisible();
  // F1 opens the palette with the ">" command prefix already typed. Cursor adds checkbox inputs to the palette,
  // so the text box is picked by its class.
  await quickInput.locator("input.input").fill(`>${commandTitle}`);
  await expect(quickInput.getByRole("option", { name: commandTitle, exact: false }).first()).toBeVisible();
  await window.keyboard.press("Enter");
}

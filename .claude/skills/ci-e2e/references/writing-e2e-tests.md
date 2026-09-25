# Writing E2E tests for Fusen

The tests launch a real VS Code (stable, downloaded by `@vscode/test-electron`) with Playwright's `_electron.launch`, load Fusen from `packages/extension` as a development extension, and open `e2e/fixtures/workspace`. The workbench is ordinary DOM, so Playwright locators work on it.

## Helpers (`e2e/helpers/vscode.ts`)

| Helper | What it does |
| --- | --- |
| `launchVSCode(openFile)` | Starts VS Code with a fresh profile, opens the fixture workspace and `openFile` (relative to it), and waits until the Fusen status bar item is visible, which means the extension has activated. Returns `{ app, window }`; close `app` in `finally`. |
| `runCommand(window, commandTitle)` | Opens the command palette with F1, types the command title, waits for a matching entry and presses Enter. The palette runs its top match, so pass the full title as the palette shows it. |

`e2e/tests/command-palette.spec.ts` shows the pattern: run a command, drive the input it opens with the keyboard, assert on the result, take a screenshot.

Add a helper to `e2e/helpers/vscode.ts` when an operation is needed by more than one test, and cover it with a test so that a VS Code update that breaks it fails CI.

## Choosing selectors

1. Prefer roles and accessible names: `window.getByRole("option", { name: ... })`, `getByRole("button", { name: ... })`. VS Code labels most widgets for screen readers, and these names change less often than CSS classes.
2. For workbench parts without a useful role, use the stable part class and narrow it with text: `.statusbar-item` with `hasText`, `.quick-input-widget`, `.monaco-editor`.
3. Avoid positional selectors (`nth`, pixel coordinates) and generated ids; they break when the layout or VS Code version changes.
4. To find a selector for a new element, dump the DOM around it from a test, run it in CI, and read the output in the job log:

   ```ts
   console.log(await window.locator(".monaco-editor").first().evaluate((element) => element.outerHTML));
   ```

## Waiting

- Wait on the state you need with web-first assertions (`await expect(locator).toBeVisible()`, `toHaveText`, …). They retry until the timeout. Never use fixed sleeps (`waitForTimeout`).
- Start from `launchVSCode`, which already waits for Fusen's activation; commands and editors are ready after it returns.
- After an action, assert on its visible effect before the next action (for example, the status bar showing `Ln 5, Col 1` after Go to Line) so that failures point at the step that went wrong.
- The Playwright timeout per test is 180 seconds (`e2e/playwright.config.ts`) because the first VS Code download and launch dominate the run time. Keep individual waits at the default expect timeout unless an operation is known to be slow, and write down why when raising it.

## Gutter and comment threads

Fusen's comments use the VS Code Comments API, so its UI is the comment gutter and the inline thread widget. Once the extension provides commenting ranges for a document, hovering a line in the editor margin shows the "add comment" glyph for that line, and clicking it opens a thread widget below the line.

- Target the line through the editor margin: hover the line number element in `.monaco-editor .margin-view-overlays` whose text is the line number, then click the glyph that appears in the same row.
- The glyph and thread widget classes are internal to VS Code. Find them with the DOM dump above in the first test that needs them, then wrap the operation in a helper (for example `addCommentOnLine(window, line)`) so that only the helper changes when VS Code does.
- Assert on the thread widget's visible content (the comment body text) rather than on its internal structure, and take a screenshot with the thread open.

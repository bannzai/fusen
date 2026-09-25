# Writing E2E tests for Fusen

The tests launch a real VS Code (stable, downloaded by `@vscode/test-electron`) with Playwright's `_electron.launch`, load Fusen from `packages/extension` as a development extension, and open a workspace. The workbench is ordinary DOM, so Playwright locators work on it. CI runs the same tests in Cursor, whose executable is passed as `FUSEN_E2E_EXECUTABLE_PATH`, so a test must not depend on anything only VS Code shows. CI also runs them with the packaged VSIX installed instead of the development extension (`FUSEN_E2E_VSIX_PATH`, jobs `e2e-vsix` and `e2e-cursor-vsix`), so a test must not depend on the extension being loaded from the source tree.

## Helpers

| Helper | What it does |
| --- | --- |
| `launchVSCode({ profilePath, workspacePath, filePath })` (`e2e/launch.ts`) | Starts VS Code with the extension under development, or with the VSIX at `FUSEN_E2E_VSIX_PATH` installed into the profile, and opens the workspace and the file. Launches that share `profilePath` share user data and extensions, like restarts of the same installation. Returns the `ElectronApplication`; get the window with `app.firstWindow({ timeout: vscodeStartupTimeoutMs })` and close `app` in `finally`. |
| `runCommand(window, commandTitle)` (`e2e/command-palette.ts`) | Opens the command palette with F1, types the command title, waits for a matching entry and presses Enter. The palette runs its top match, so pass the full title as the palette shows it. |
| `addNote(window, lineText, noteText)` (`e2e/notes.ts`) | Clicks the gutter at the line of the open editor that contains `lineText`, types `noteText` into the new thread and presses `Add Note`, then waits for the note to be shown. |

Examples:

- `e2e/tests/activation.spec.ts`: launch, wait for activation, screenshot
- `e2e/tests/command-palette.spec.ts`: run a command, drive the input it opens with the keyboard, assert on the result
- `e2e/tests/threads.spec.ts`: add a note from the gutter, restart VS Code with the same profile, and edit a thread; it copies the fixture workspace into the profile directory so that the `.fusen/` it writes stays out of the repository

Add a helper as a module next to `e2e/launch.ts` (and to `include` in `e2e/tsconfig.json`) when an operation is needed by more than one test, and cover it with a test so that a VS Code update that breaks it fails CI.

## Choosing selectors

1. Prefer roles and accessible names: `window.getByRole("option", { name: ... })`, `getByRole("button", { name: ... })`. VS Code labels most widgets for screen readers, and these names change less often than CSS classes.
2. For workbench parts without a useful role, use the part class and narrow it with text: `.statusbar-item` with `hasText`, `.quick-input-widget`, `.view-line` with `hasText`, `.review-widget` with `hasText`.
3. Avoid fixed positions (`nth`, hard-coded pixel coordinates) and generated ids; they break when the layout or VS Code version changes. When a position is unavoidable, compute it from the bounding boxes of elements found by the rules above (see the gutter section).
4. To find a selector for a new element, dump the DOM around it from a test, run it in CI, and read the output in the job log:

   ```ts
   console.log(await window.locator(".monaco-editor").first().evaluate((element) => element.outerHTML));
   ```

## Waiting

- Wait on the state you need with web-first assertions (`await expect(locator).toBeVisible()`, `toHaveText`, …) or `expect.poll` for state outside the DOM such as `.fusen/` files. They retry until the timeout. Never use fixed sleeps (`waitForTimeout`).
- After launching, wait for the Fusen status bar item (`.statusbar-item` with text `Fusen`); it is created in `activate`, so commands and comment threads are ready after it appears.
- After an action, assert on its visible effect before the next action (for example, the status bar showing `Ln 5, Col 1` after Go to Line) so that failures point at the step that went wrong.
- The Playwright timeout per test is 180 seconds (`e2e/playwright.config.ts`) because VS Code start-up dominates the run time. A test that launches VS Code more than once raises it with `test.setTimeout`. Keep other waits at the default expect timeout unless an operation is known to be slow, and write down why when raising it.

## Gutter and comment threads

Fusen's comments use the VS Code Comments API, so its UI is the comment gutter and the inline thread widget (`.review-widget`). `e2e/notes.ts` and `e2e/tests/threads.spec.ts` drive both:

- The "add comment" glyphs (`.margin-view-overlays .comment-range-glyph`) share one column for all lines. Find the target line with `.view-line` and its text, wait for a laid-out glyph (`.filter({ visible: true }).first()`), then click at the glyph's x and the target line's y taken from their bounding boxes. The editor re-renders its lines and gutter each time it reads the comment threads, several times around startup, so read both boxes again until they are read together (`expect(...).toPass()`) instead of reading them once after `toBeVisible`.
- Type into the thread's comment editor (`.comment-form .monaco-editor`) with the keyboard, then press the button by its accessible name (`Add Note`, `Reply`, `Save`, …).
- Assert on the visible content (`.comment-body` with the text) and on the saved `.fusen/` files through `fusen-core`, and take a screenshot with the thread open.

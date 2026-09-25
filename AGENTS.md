# Fusen

VS Code extension + MCP server that puts sticky-note comments on code lines and exchanges them with AI agents in both directions.

## Documents

- `documents/PROJECT.md` is the source of truth for requirements, architecture decisions and rejected options. Update it in the same change when a design decision changes.

## Verification

Builds, tests and anything that launches VS Code or a browser run on an external machine, not on the local development machine, to keep its load low. Fusen is a public repository, so the external machine is GitHub Actions (`.github/workflows/ci.yml`, free for public repositories). simtunnel is for iOS / macOS apps and does not apply; if the repository ever becomes private, use a Devin session instead of GitHub Actions.

- The `ci-e2e` skill (`.claude/skills/ci-e2e/SKILL.md`) runs the steps below as one script and covers how to write E2E tests
- Push the branch and open a pull request; CI runs on every pull request. To run it on a branch without a pull request: `gh workflow run ci.yml --ref <branch>`
- CI steps, which are the verification commands: `npm ci` → `npm run typecheck` → `npm run build` → `npm test` (job `build-test`), `npm run build` → `npm run package --workspace packages/extension` (job `package-vsix`, uploads the `fusen-vsix` artifact), and `npm run build` → `xvfb-run -a npm run test:e2e` (job `e2e`)
- Wait for and inspect results: `gh pr checks <pr> --watch`, then `gh run view <run-id> --log-failed` for failures
- Visual check: the `e2e` job uploads Playwright output, including screenshots, as the `e2e-screenshots` artifact. Download it with `gh run download <run-id> -n e2e-screenshots -D ./tmp/e2e-<run-id>` and Read the PNG files to judge the UI
- When adding UI behavior, extend an E2E test in `e2e/tests/` so it drives the UI and saves a screenshot with `testInfo.outputPath(...)`; that screenshot is the evidence of the change
- Updating `package-lock.json` locally is fine with `npm install --package-lock-only`, which resolves dependencies without installing or building

<!-- ai-review-config begin -->
<!--
このブロックは自動生成です。直接編集せず、テンプレートを更新してから再生成してください。
内容は AI コードレビュー時の挙動指示であり、コードベース自体への規約ではありません。
-->

## レビュー時の応答スタイル

- 応答は日本語で行う

## レビュー範囲外

以下は自動レビューで指摘しない (別の検出経路があるため):

- コンパイルエラー・型エラー (ローカル/CI のビルドで検出される)
- Lint/フォーマット違反 (リンター・フォーマッターで検出される)
<!-- ai-review-config end -->

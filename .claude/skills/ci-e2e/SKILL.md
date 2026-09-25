---
name: ci-e2e
description: Run Fusen's E2E tests on GitHub Actions, wait for the run, download the e2e-screenshots artifact into ./tmp and read the screenshots to judge the UI; on failure, read the failed logs. Also covers how to extend the E2E tests with VS Code UI operations (command palette, gutter). Use when verifying a change in Fusen's UI, checking a CI result, or writing a new E2E test.
---

# CI E2E

Fusen does not run builds, tests or VS Code on the development machine (`AGENTS.md`, Verification). E2E tests run in the `e2e` job of `.github/workflows/ci.yml`, which uploads Playwright's output directory, screenshots included, as the `e2e-screenshots` artifact. This skill turns "push, wait for CI, fetch the artifact, look at the screenshots, read the logs on failure" into one script and a checklist.

Run every command from the repository root. Scripts are referenced by repository-relative paths so that both Claude Code (`.claude/skills/ci-e2e`) and Codex CLI (`.agents/skills/ci-e2e`, a symlink to the same directory) can run them.

## Run and check

1. Commit and push the branch. A pull request triggers CI on every push. For a branch without a pull request, add `--dispatch` in the next step to start the run with `gh workflow run ci.yml --ref <branch>` (GitHub only accepts this once `ci.yml` exists on the default branch).
2. Fetch the result of the pushed commit:

   ```sh
   bash .claude/skills/ci-e2e/scripts/fetch-e2e-screenshots.sh            # the run for HEAD on the current branch
   bash .claude/skills/ci-e2e/scripts/fetch-e2e-screenshots.sh --dispatch # start a new run and use it
   bash .claude/skills/ci-e2e/scripts/fetch-e2e-screenshots.sh --run-id <id>
   ```

   The script waits for the run to be created and finished, downloads the artifact into `./tmp/e2e-<run id>/` (skipped when that directory already exists; it is created only after a complete download) and prints `RUN_ID`, `RUN_URL`, `CONCLUSION`, `DIR` and one `SCREENSHOT=<path>` line per PNG. Options and exit codes are documented at the top of the script.
3. Read every `SCREENSHOT` path with the Read tool and judge whether the UI shows what the change intends. A passing test only proves the assertions; the screenshot is the evidence for anything visual.
4. When the script exits 1 (`CONCLUSION` is not `success`), run the printed `FAILED_LOG_COMMAND` (`gh run view <id> --log-failed`) and read the failure. The artifact is uploaded even when the job fails, so the screenshots a test saved before failing are still listed. Fix, push, and go back to step 2.
5. Record the run URL and what the screenshots showed in the pull request body.

Exit code 3 means no run was found or a `gh` call failed; the message says which. The usual cause is that the commit has not been pushed yet or the branch has no pull request (use `--dispatch`).

Exit code 4 means the run finished but its artifact could not be downloaded, so there is nothing to look at. A run that failed before the `e2e` job uploaded anything ends here too; read `FAILED_LOG_COMMAND` if it was printed, otherwise rerun the script, which retries the download.

## Extending the E2E tests

Tests live in `e2e/tests/*.spec.ts`; shared helpers in `e2e/helpers/vscode.ts`. Read `references/writing-e2e-tests.md` before adding UI operations; it covers the helpers, selector choice and waiting.

Every test that adds UI behavior saves a screenshot with `testInfo.outputPath("<name>.png")` so that it ends up in the artifact.

## Tests of this skill

`scripts/test/test-fetch-e2e-screenshots.sh` checks the script's argument validation, run lookup, idempotent download and failure handling with a stub `gh`, so it needs no GitHub access. It runs as part of `npm test` in CI.

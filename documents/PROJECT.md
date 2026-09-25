# Fusen

Fusen (付箋, "sticky note") puts review comments on code lines and exchanges them with AI agents in both directions.

## Problem

AI agents (Claude Code, Codex CLI) point at code as "file path + line number" in chat, so the reader has to open the file and find the line. The reverse is just as tedious: to ask for a change on a specific line, the reader copies the path and line number into the chat. If comments live on the line in the editor, this round trip disappears.

## Requirements

- Comment on any line or range of any file in the current working tree. No git diff is required, and uncommitted code works.
- Human to AI: export all open comments as one markdown prompt. The same comments are readable over MCP.
- AI to human: an agent posts comments on lines over MCP. The human approves or rejects each one in the editor before it becomes a regular comment.
- Claude Code and Codex CLI use the same path (one MCP server).
- Fusen is built in-house instead of installing a third-party extension. An AI agent must be able to verify it end to end by looking at screenshots.

## Architecture

| Part | Decision | Reason |
| --- | --- | --- |
| Editor UI | VS Code extension on the Comments API (`vscode.comments.createCommentController`) | The gutter thread UI is the same one the GitHub Pull Requests extension uses, so Fusen only builds persistence, MCP and the approval flow. Cursor runs the same extension host. |
| Storage | Plain files under `.fusen/` in the workspace | Source files stay untouched. The extension and the MCP server read and write the same files and pick up each other's changes with file watching. |
| AI access | MCP server as a separate stdio process (`packages/mcp-server`, `npx fusen-mcp`) | One line registers it in both Claude Code (`.mcp.json`) and Codex CLI, and it works without the editor running. |
| Approval | AI-written comments go to `.fusen/_pending/`; the extension shows them as threads with approve / reject actions | Nothing an agent writes becomes a regular comment until a human accepts it. |
| E2E | Playwright `_electron.launch` against a VS Code build downloaded by `@vscode/test-electron`, with `--extensionDevelopmentPath` | Same approach as the VS Code smoke tests. The test saves screenshots that an agent reads to judge the UI. |

There is no database, backend, hosting, authentication, analytics or billing. Fusen collects no user data; everything stays in the workspace's `.fusen/` directory.

## Rejected options

- **macOS app**: would rebuild an editor and diff viewer and re-implement the gutter UI that the Comments API provides, and would live apart from the editor where code is read.
- **Marker comments (`// AI: ...` found by grep)**: zero development and works with both CLIs, but has no AI-to-human direction and no MCP. Usable as a stopgap until Fusen ships.
- **Draft pull request + GitHub review comments**: requires commit and push, so it does not work on uncommitted code.

## Prior art

| Extension | Comment on any line | MCP | Approval of AI comments | Notes |
| --- | --- | --- | --- | --- |
| ReviewMate (https://github.com/stefanpantic/local-review-vscode-extension) | No (requires a git diff base) | Yes (HTTP inside the extension) | No explicit UI; deleting is rejecting | Aimed at PR-style comments on a diff |
| Code Context Notes (https://github.com/jnahian/code-context-notes) | Yes | Yes (stdio, `@jnahian/code-notes-mcp`) | Yes (`agentWriteMode: queue` into `_pending/`) | CodeLens + sidebar instead of gutter threads; tracks lines by content hash. Closest design reference |
| Local Review to Markdown (https://github.com/tmsdnl/vscode-local-review-md) | Yes | No | No | Gutter notes exported to markdown |
| Local HITL Review (https://github.com/pabloubal/local-hitl-review) | Not stated | No (agents edit `.feedback/` markdown) | Agent updates status | Shared-file approach |
| Local Code Review (https://github.com/prateek/vscode-local-code-review) | Yes | No | No | `.code-review/threads/*.md` storage format |

Origin: https://github.com/bannzai/IdeaMemo/issues/337

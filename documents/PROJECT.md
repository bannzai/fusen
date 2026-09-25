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

## Storage format

Each workspace folder has its own `.fusen/` directory. `packages/core` (`fusen-core`) is the only code that reads and writes it; the extension and the MCP server both use it.

### `.fusen/threads/<id>.json`

One file per thread. `<id>` is the thread's `id` and contains only `A-Z a-z 0-9 _ -` (new ids are UUIDs), so it cannot point outside the directory.

```json
{
  "version": 1,
  "id": "0b6c1e0a-3f7e-4a53-9d53-6a2d8f1c9e41",
  "file": "src/sample.ts",
  "startLine": 6,
  "endLine": 6,
  "comments": [
    {
      "id": "5f0d3a4e-8c1b-4d2f-a9e7-2b1c0d9e8f7a",
      "body": "Rename add to sum",
      "author": "human",
      "createdAt": "2026-09-25T00:00:00.000Z"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Format version, raised only for a change that older readers cannot handle |
| `file` | Path relative to the workspace folder with `/` separators. Absolute paths and `..` segments are rejected |
| `startLine`, `endLine` | 1-based inclusive line range, the numbering people and agents use when they talk about code |
| `comments` | In posting order, never empty: deleting the last comment deletes the file |
| `comments[].body` | Markdown |
| `comments[].author` | `human` (written in the editor) or `agent` (written over MCP) |
| `comments[].createdAt` | ISO 8601 |

Files are written to a temporary file in the same directory and renamed into place, so a reader never sees a partial file. A file that fails validation is reported and skipped; the other threads still load. Nothing in the format depends on git, so uncommitted and untracked files can be commented.

### `.fusen/_pending/<id>.json`

Comments an agent writes over MCP wait here until a human approves or rejects them in the editor (implemented in a later issue). One file per proposal, with the same `version` and id rules as threads:

- A new thread: the same shape as a thread file, with every comment's `author` set to `agent`. Approving moves it to `.fusen/threads/<id>.json`.
- A reply to an existing thread: `{ "version": 1, "id": "<proposal id>", "threadId": "<thread id>", "comment": { ... } }`, where `comment` has the fields of `comments[]`. Approving appends the comment to that thread.

Rejecting deletes the proposal file.

### `.fusen/prompt.md`

The output of the `Fusen: Export comments as prompt to .fusen/prompt.md` command, overwritten on every export and never read back. `Fusen: Copy comments as prompt` puts the same markdown on the clipboard. `createPrompt` in `fusen-core` generates it, so that the MCP server can return the same prompt. It holds every thread of one workspace folder, or only those of the file in the active editor, ordered by file and line: each section is `<file>:<startLine>-<endLine>`, the code of those lines as it is on disk when the prompt is made, and the comments in posting order. The storage format has no resolved state, so every stored thread counts as open.

Rejected alternatives: a single `.fusen/threads.json` makes the extension and the MCP server overwrite each other's concurrent changes and conflicts on every edit in git, and markdown files per thread (as in Local Code Review) need a parser for metadata that JSON gives for free.

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

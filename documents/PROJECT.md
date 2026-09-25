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

Comments an agent writes over MCP wait here until a human approves or rejects them in the editor. The MCP server writes only to this directory and never changes `.fusen/threads/`. One file per proposal, with the same `version` and id rules as threads:

- A new thread: the same shape as a thread file, with every comment's `author` set to `agent`. Approving moves it to `.fusen/threads/<id>.json`, so the proposal id becomes the thread id.
- A reply to an existing thread: `{ "version": 1, "id": "<proposal id>", "threadId": "<thread id>", "comment": { ... } }`, where `comment` has the fields of `comments[]`, `author` is `agent` and `id` equals the proposal id. Approving appends the comment to that thread.

Rejecting deletes the proposal file and keeps no record. The approval status an agent reads is derived from the files instead: approved when a thread has the proposal id as its thread id or as a comment id, otherwise pending while `.fusen/_pending/<id>.json` exists, and rejected otherwise. Approval writes the thread before it deletes the proposal, so a proposal already in a thread counts as approved, and the extension deletes such a leftover proposal file the next time it reads the directory. A pending reply whose thread file no longer exists (not one that merely fails validation) is deleted, that is rejected, at the same point, since its approve and reject actions would be shown in that thread; deleting a thread in the editor re-reads the directory right away. The cost is that a proposal whose approved thread or comment was deleted later also reads as rejected; a rejection log would tell the two apart, but it would be one more directory that grows forever for a distinction an agent does not act on differently.

The extension watches `.fusen/` in every workspace folder and re-reads `.fusen/_pending/` on each change, so a proposal appears, changes or disappears in the editor as soon as the MCP server or anything else writes it. VS Code's file watcher can miss changes (in CI, proposals written right after startup into a new `.fusen/_pending/` never produced an event, and the Explorer did not show `.fusen` either), so the extension also compares the modification time of `.fusen/_pending/` every two seconds and re-reads it when the time changed. Proposals are written by renaming a file into the directory and removed by deleting it, and both change that time. A proposed thread is shown as its own thread labelled "Pending approval" with approve and reject actions in its header; a proposed reply is shown at the end of the thread it replies to, labelled the same, with the actions on the comment.

### `.fusen/prompt.md`

The output of the `Fusen: Export comments as prompt to .fusen/prompt.md` command, overwritten on every export and never read back. `Fusen: Copy comments as prompt` puts the same markdown on the clipboard. `createPrompt` in `fusen-core` generates it, so that the MCP server can return the same prompt. It holds every thread of one workspace folder, or only those of the file in the active editor, ordered by file and line: each section is `<file>:<startLine>-<endLine>`, the code of those lines as it is on disk when the prompt is made, and the comments in posting order. The storage format has no resolved state, so every stored thread counts as open.

Rejected alternatives: a single `.fusen/threads.json` makes the extension and the MCP server overwrite each other's concurrent changes and conflicts on every edit in git, and markdown files per thread (as in Local Code Review) need a parser for metadata that JSON gives for free.

## MCP tools

The server treats its working directory as the workspace folder, so an MCP client registration starts it in the project directory.

| Tool | What it does |
| --- | --- |
| `post_comment` | Writes a proposed thread on `file` from `startLine` to `endLine` (1-based, `endLine` defaults to `startLine`). Fails when the path leaves the workspace folder, the file cannot be read, or a line is past the end of the file (counted as the editor counts, so the empty line after a final newline exists) |
| `reply_to_thread` | Writes a proposed reply to `threadId`. Fails when `.fusen/threads/` has no such thread |
| `get_proposal_status` | Returns `pending`, `approved` or `rejected` for a proposal id, derived from the files as described under `.fusen/_pending/<id>.json` |

Every tool returns `{ proposalId, status }` as structured content and as JSON text.

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

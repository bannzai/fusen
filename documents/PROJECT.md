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
| AI access | MCP server as a separate stdio process (`packages/mcp-server`, `node fusen-mcp.js`) | One line registers it in both Claude Code (`.mcp.json`) and Codex CLI, and it works without the editor running. |
| Approval | AI-written comments go to `.fusen/_pending/`; the extension shows them as threads with approve / reject actions | Nothing an agent writes becomes a regular comment until a human accepts it. |
| Distribution | The extension as a VSIX and the MCP server as one JavaScript file (`fusen-mcp.js`), both attached to GitHub Releases by `.github/workflows/release.yml` on a `v*` tag. Nothing is published to npm, the VS Code Marketplace or Open VSX. The VSIX bundles the extension and `fusen-core` into one file with esbuild, and `fusen-mcp.js` bundles the server with every dependency (`fusen-core`, `@modelcontextprotocol/sdk`, `zod`), so it loads nothing but Node built-ins. A clone's build writes the same file as `packages/mcp-server/dist/index.js` | Decided in https://github.com/bannzai/fusen/issues/9, https://github.com/bannzai/fusen/issues/6 and https://github.com/bannzai/fusen/issues/23. The VSIX ships no `node_modules` (the workspace packages are hoisted outside the extension directory), and `fusen-core` is a private workspace package, so the bundles are what make `fusen-core` available at run time. Publishing the server to npm (`npx fusen-mcp`) was rejected in #23: it needs an npm account and a publish token only to deliver one file, which a release asset delivers with `node` alone. `fusen-mcp.js` is an ES module without a `package.json` beside it, so it relies on Node.js syntax detection (on by default since 22.7.0, https://nodejs.org/api/packages.html) and fails under a `package.json` with `"type": "commonjs"`; the server therefore requires Node.js 22.7 or later. Naming it `.mjs` would remove both conditions, but #23 fixed the file name as `fusen-mcp.js`. Publishing `fusen-core` as a second npm package was rejected earlier: it adds a public package, its name and its token scope only to share code inside this repository. The server bundle is ESM while `fusen-core` builds to CommonJS, so the bundle defines `require` with `createRequire` for the `require` calls of `fusen-core` |
| E2E | Playwright `_electron.launch` against a VS Code build downloaded by `@vscode/test-electron`, with `--extensionDevelopmentPath`. CI runs the same tests in Cursor too: the latest stable Linux AppImage from Cursor's download API (`https://cursor.com/api/download?platform=linux-x64&releaseTrack=stable`), extracted with `--appimage-extract` and launched through `FUSEN_E2E_EXECUTABLE_PATH` | Same approach as the VS Code smoke tests. The test saves screenshots that an agent reads to judge the UI. Cursor runs the same workbench and extension host, so running the tests in it replaces checking Cursor by hand (https://github.com/bannzai/fusen/issues/24). The AppImage is extracted because GitHub's Ubuntu runners have no FUSE to mount it. |

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
  "code": ["  return a + b;"],
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
| `startLine`, `endLine` | 1-based inclusive line range, the numbering people and agents use when they talk about code. It refers to the file as saved on disk |
| `code` | Text of each line from `startLine` to `endLine` when the thread was last placed, used to find the lines again (see "Following code changes"). Optional: a thread written without it, on unsaved changes in the editor or by other tools, takes the text at its lines the next time the extension places it or the document is saved |
| `comments` | In posting order, never empty: deleting the last comment deletes the file |
| `comments[].body` | Markdown |
| `comments[].author` | `human` (written in the editor) or `agent` (written over MCP) |
| `comments[].createdAt` | ISO 8601 |

Files are written to a temporary file in the same directory and renamed into place, so a reader never sees a partial file. A file that fails validation is reported and skipped; the other threads still load. Nothing in the format depends on git, so uncommitted and untracked files can be commented.

### `.fusen/_pending/<id>.json`

Comments an agent writes over MCP wait here until a human approves or rejects them in the editor. The MCP server writes only to this directory and never changes `.fusen/threads/`. One file per proposal, with the same `version` and id rules as threads:

- A new thread: the same shape as a thread file, with every comment's `author` set to `agent`. `post_comment` stores the `code` of the lines as they were when the agent posted, so the approved thread is placed on that code even if the file changed while the proposal waited. Approving moves it to `.fusen/threads/<id>.json`, so the proposal id becomes the thread id.
- A reply to an existing thread: `{ "version": 1, "id": "<proposal id>", "threadId": "<thread id>", "comment": { ... } }`, where `comment` has the fields of `comments[]`, `author` is `agent` and `id` equals the proposal id. Approving appends the comment to that thread.

Rejecting deletes the proposal file and keeps no record. The approval status an agent reads is derived from the files instead: approved when a thread has the proposal id as its thread id or as a comment id, otherwise pending while `.fusen/_pending/<id>.json` exists, and rejected otherwise. Approval writes the thread before it deletes the proposal, so a proposal already in a thread counts as approved, and the extension deletes such a leftover proposal file the next time it reads the directory. A pending reply whose thread file no longer exists (not one that merely fails validation) is deleted, that is rejected, at the same point, since its approve and reject actions would be shown in that thread; deleting a thread in the editor re-reads the directory right away. The cost is that a proposal whose approved thread or comment was deleted later also reads as rejected; a rejection log would tell the two apart, but it would be one more directory that grows forever for a distinction an agent does not act on differently.

The extension watches `.fusen/` in every workspace folder and re-reads `.fusen/_pending/` on each change, so a proposal appears, changes or disappears in the editor as soon as the MCP server or anything else writes it. VS Code's file watcher can miss changes (in CI, proposals written right after startup into a new `.fusen/_pending/` never produced an event, and the Explorer did not show `.fusen` either), so the extension also compares the modification time of `.fusen/_pending/` every two seconds and re-reads it when the time changed. Proposals are written by renaming a file into the directory and removed by deleting it, and both change that time. A proposed thread is shown as its own thread labelled "Pending approval" with approve and reject actions in its header; a proposed reply is shown at the end of the thread it replies to, labelled the same, with the actions on the comment. A replied thread written after the workspace was opened, for example by a git checkout, is shown when a reply to it is read.

### `.fusen/prompt.md`

The output of the `Fusen: Export comments as prompt to .fusen/prompt.md` command, overwritten on every export and never read back. `Fusen: Copy comments as prompt` puts the same markdown on the clipboard. `createPrompt` in `fusen-core` generates it, so that the MCP server can return the same prompt. It holds every thread of one workspace folder, or only those of the file in the active editor, ordered by file and line: each section is `<file>:<startLine>-<endLine>`, the code of those lines as it is on disk when the prompt is made, and the comments in posting order. The storage format has no resolved state, so every stored thread counts as open.

Rejected alternatives: a single `.fusen/threads.json` makes the extension and the MCP server overwrite each other's concurrent changes and conflicts on every edit in git, and markdown files per thread (as in Local Code Review) need a parser for metadata that JSON gives for free.

### Following code changes

A thread stays on the code it was written on while the file changes. `packages/core` (`location.ts`) holds the logic; the extension applies it.

- **Edits in the editor**: each edit moves the thread's range in memory (lines added or removed above it, or a line break typed into the indentation of its first line, move it; lines added or removed inside it grow or shrink it; a line break typed after the code of its last line leaves it as it is). The new lines and their `code` are written to `.fusen/` when the document is saved, not on every edit, because `startLine` / `endLine` must refer to the file on disk that the MCP server and agents read. Deleting every commented line makes the thread's location unknown.
- **Changes outside the editor** (git checkout, an agent rewriting the file, edits undone to the saved text, or changes while the workspace was closed): the thread is placed where its `code` is now in the file, and the new lines are written to `.fusen/`. Leading and trailing whitespace is ignored so that re-indenting does not lose the thread; when the code appears more than once, the match nearest to the old `startLine` wins.
- **Location unknown**: when the code is no longer in the file (the commented lines were changed or deleted outside the editor, or the file was deleted), the thread is shown at its stored lines with the label "Location unknown". Its stored lines and `code` are kept unchanged, so it is placed again if the code comes back (for example after checking out the previous branch, or by undoing the deletion in the editor). Edits do not move it until then.

Rejected alternative: a content hash of the lines, as Code Context Notes uses. It supports only an exact match, and agents cannot read it; the stored text also lets the whitespace-insensitive comparison work.

### Showing threads in the editor

An editor reads the comment threads of its file from every comment controller when a controller is registered or changes its commenting ranges and when a file is opened, and it replaces all of its thread widgets with the result of each read. VS Code (checked in 1.139.0) can drop a thread that an extension creates while two of those reads are in flight, which happens around startup: when the earlier read finishes, the editor forgets that the later one is still running (`_computePromise = null` in `commentsController.ts`), shows the new thread at once, and then applies the later read, whose list was taken before the thread existed (`getDocumentComments` in `mainThreadComments.ts`). Nothing reads again afterwards, so a note restored at startup, or a proposal that arrived then, stayed hidden until its file was opened again (https://github.com/bannzai/fusen/issues/18).

After it creates editor threads for stored threads or proposals, the extension therefore assigns its commenting range provider again, once per turn of the event loop. That makes every editor read its threads again after the new threads exist, and since each controller answers reads in order, that read is applied last. The cost is that the editors rebuild their thread widgets once more; VS Code keeps the unsent text of a reply or an edit across the rebuild.

## MCP tools

The server reads and writes the `.fusen/` of one workspace folder: the `--workspace <path>` argument, else `CLAUDE_PROJECT_DIR`, else its working directory. Claude Code sets `CLAUDE_PROJECT_DIR` to the project root for the stdio servers it starts (https://code.claude.com/docs/en/mcp), so a Claude Code registration works without an argument; Codex CLI passes nothing like it, so its registration sets `cwd` or `--workspace`. A Fusen-specific environment variable was rejected because the argument already covers every client. The server reads `.fusen/` directly and does not need the extension to be running.

| Tool | What it does |
| --- | --- |
| `list_comments` | Returns `{ threads, pendingProposals, invalidFiles }`: the threads in `.fusen/threads/` (status `open`) and the proposals in `.fusen/_pending/` (status `pending`), in the storage format, optionally only those on `file` or with `status`. A proposed reply is on the file of the thread it replies to. `invalidFiles` lists the files that failed validation, as the extension warns about them |
| `get_file_comments` | The same result as `list_comments` for one `file` with both statuses |
| `get_prompt` | Returns the markdown of `createPrompt` for every thread, or those on `file`, the same text as `Fusen: Copy comments as prompt`. Proposals are not included. Each skipped invalid file is reported in a separate text block after the prompt |
| `post_comment` | Writes a proposed thread on `file` from `startLine` to `endLine` (1-based, `endLine` defaults to `startLine`). Fails when the path leaves the workspace folder, the file cannot be read, or a line is past the end of the file (counted as the editor counts, so the empty line after a final newline exists) |
| `reply_to_thread` | Writes a proposed reply to `threadId`. Fails when `.fusen/threads/` has no such thread |
| `get_proposal_status` | Returns `pending`, `approved` or `rejected` for a proposal id, derived from the files as described under `.fusen/_pending/<id>.json` |

`post_comment`, `reply_to_thread` and `get_proposal_status` return `{ proposalId, status }`, and `list_comments` and `get_file_comments` their result, as structured content and as JSON text. The read tools declare no output schema, because it would repeat the storage format in a second place. A `file` that is not a path relative to the workspace folder with `/` separators is an error rather than an empty result, so that an agent passing an absolute path learns why nothing matched.

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

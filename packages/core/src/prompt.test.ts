import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPrompt, promptFilePath, writePrompt } from "./prompt.js";
import type { FusenComment, FusenThread } from "./threads.js";

/** Creates a workspace folder holding `files`, keyed by their workspace-relative paths. */
async function createWorkspace(files: Record<string, string>): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "fusen-core-prompt-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspaceRoot, file)), { recursive: true });
    await writeFile(path.join(workspaceRoot, file), content, "utf8");
  }
  return workspaceRoot;
}

/** Returns a thread with the id `id` on lines `startLine`-`endLine` of `file`. */
function thread(id: string, file: string, startLine: number, endLine: number, comments: FusenComment[]): FusenThread {
  return { version: 1, id, file, startLine, endLine, comments };
}

/** Returns a comment with `body` by `author`. */
function comment(id: string, body: string, author: FusenComment["author"] = "human"): FusenComment {
  return { id, body, author, createdAt: "2026-09-25T00:00:00.000Z" };
}

const sampleSource = [
  "export function greet(name: string): string {",
  "  return `Hello, ${name}`;",
  "}",
  "",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

test("createPrompt lists threads by file and line with the code of their lines and their comments", async () => {
  const workspaceRoot = await createWorkspace({
    "src/sample.ts": sampleSource,
    "docs/notes.md": "Run it with:\n```sh\nnpm test\n```\n",
  });
  const threads = [
    thread("t1", "src/sample.ts", 5, 7, [
      comment("c1", "Rename add to sum"),
      comment("c2", "Done.\n\nSee `sum`.", "agent"),
    ]),
    thread("t2", "src/sample.ts", 20, 20, [comment("c3", "This line was deleted")]),
    thread("t3", "src/deleted.ts", 1, 1, [comment("c4", "Remove this file")]),
    thread("t4", "docs/notes.md", 2, 4, [comment("c5", "Use npm ci")]),
    thread("t5", "src/sample.ts", 2, 2, [comment("c6", "Greet in Japanese")]),
  ];

  assert.equal(
    await createPrompt(workspaceRoot, threads),
    `# Fusen comments

5 comment threads on 3 files. Each section is a line range of a file, the code on those lines, and the comments on it in posting order. Paths are relative to the workspace root and line numbers start at 1.

## docs/notes.md:2-4

\`\`\`\`md
\`\`\`sh
npm test
\`\`\`
\`\`\`\`

**Human:**

Use npm ci

## src/deleted.ts:1

_The file could not be read._

**Human:**

Remove this file

## src/sample.ts:2

\`\`\`ts
  return \`Hello, \${name}\`;
\`\`\`

**Human:**

Greet in Japanese

## src/sample.ts:5-7

\`\`\`ts
export function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

**Human:**

Rename add to sum

**Agent:**

Done.

See \`sum\`.

## src/sample.ts:20

_The file has only 7 lines._

**Human:**

This line was deleted
`,
  );
});

test("createPrompt puts the commit and the state of the file between the author and the body of a comment with a git state", async () => {
  const workspaceRoot = await createWorkspace({ "sample.ts": sampleSource });
  const commit = "0b6c1e0a3f7e4a539d536a2d8f1c9e4100000000";
  const comments: FusenComment[] = [
    { ...comment("c1", "Clean"), git: { commit, branch: "main", staged: false, unstaged: false, untracked: false } },
    { ...comment("c2", "Staged"), git: { commit, branch: "feature/a_b", staged: true, unstaged: false, untracked: false } },
    { ...comment("c3", "Unstaged", "agent"), git: { commit, staged: false, unstaged: true, untracked: false } },
    { ...comment("c4", "Both"), git: { commit, branch: "main", staged: true, unstaged: true, untracked: false } },
    { ...comment("c5", "Untracked"), git: { commit, branch: "main", staged: false, unstaged: false, untracked: true } },
    comment("c6", "No git"),
  ];

  const prompt = await createPrompt(workspaceRoot, [thread("t1", "sample.ts", 6, 6, comments)]);
  assert.ok(
    prompt.endsWith(
      [
        "**Human:**",
        "_Posted at commit `0b6c1e0` on branch `main`, when the file had no uncommitted changes._",
        "Clean",
        "**Human:**",
        "_Posted at commit `0b6c1e0` on branch `feature/a_b`, when the file had staged changes._",
        "Staged",
        "**Agent:**",
        "_Posted at commit `0b6c1e0` (detached HEAD), when the file had unstaged changes._",
        "Unstaged",
        "**Human:**",
        "_Posted at commit `0b6c1e0` on branch `main`, when the file had staged and unstaged changes._",
        "Both",
        "**Human:**",
        "_Posted at commit `0b6c1e0` on branch `main`, when the file was untracked._",
        "Untracked",
        "**Human:**",
        "No git\n",
      ].join("\n\n"),
    ),
    prompt,
  );
});

test("createPrompt says there are no comments when there are no threads", async () => {
  assert.equal(await createPrompt(await createWorkspace({}), []), "# Fusen comments\n\nThere are no comments.\n");
});

test("createPrompt uses the singular for one thread on one file", async () => {
  const workspaceRoot = await createWorkspace({ "sample.ts": sampleSource });
  const prompt = await createPrompt(workspaceRoot, [thread("t1", "sample.ts", 6, 6, [comment("c1", "Use sum")])]);
  assert.match(prompt, /^# Fusen comments\n\n1 comment thread on 1 file\. /);
});

test("writePrompt writes .fusen/prompt.md and replaces the previous export", async () => {
  const workspaceRoot = await createWorkspace({});
  await writePrompt(workspaceRoot, "first\n");
  await writePrompt(workspaceRoot, "second\n");

  assert.equal(promptFilePath(workspaceRoot), path.join(workspaceRoot, ".fusen", "prompt.md"));
  assert.equal(await readFile(promptFilePath(workspaceRoot), "utf8"), "second\n");
});

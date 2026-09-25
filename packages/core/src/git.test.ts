import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type FusenGitState, parseGitState, readGitState } from "./git.js";

/** Runs git with `args` in `directoryPath`, without the user's git configuration, and returns its output without the final line break. */
function git(directoryPath: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fusen Test", "-c", "user.email=fusen@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: directoryPath, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  ).trimEnd();
}

/** Creates a temporary directory holding `files`, keyed by their paths relative to it. */
async function createDirectory(files: Record<string, string>): Promise<string> {
  const directoryPath = await mkdtemp(path.join(tmpdir(), "fusen-core-git-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directoryPath, file)), { recursive: true });
    await writeFile(path.join(directoryPath, file), content, "utf8");
  }
  return directoryPath;
}

/**
 * Creates a git repository on the branch `main` whose one commit holds `committed.ts`, `staged.ts`, `unstaged.ts`,
 * `both.ts`, `src/[a].ts` and `.gitignore`, and then leaves each file in the state its name says, `untracked.ts` untracked
 * and `ignored/file.ts` ignored.
 */
async function createRepository(): Promise<string> {
  const repositoryPath = await createDirectory({
    "committed.ts": "committed\n",
    "staged.ts": "staged\n",
    "unstaged.ts": "unstaged\n",
    "both.ts": "both\n",
    "src/[a].ts": "a\n",
    ".gitignore": "ignored/\n",
  });
  git(repositoryPath, ["init", "--initial-branch=main"]);
  git(repositoryPath, ["add", "."]);
  git(repositoryPath, ["commit", "-m", "Initial commit"]);
  await writeFile(path.join(repositoryPath, "staged.ts"), "staged changed\n", "utf8");
  git(repositoryPath, ["add", "staged.ts"]);
  await writeFile(path.join(repositoryPath, "unstaged.ts"), "unstaged changed\n", "utf8");
  await writeFile(path.join(repositoryPath, "both.ts"), "both staged\n", "utf8");
  git(repositoryPath, ["add", "both.ts"]);
  await writeFile(path.join(repositoryPath, "both.ts"), "both staged and unstaged\n", "utf8");
  await writeFile(path.join(repositoryPath, "untracked.ts"), "untracked\n", "utf8");
  await mkdir(path.join(repositoryPath, "ignored"));
  await writeFile(path.join(repositoryPath, "ignored", "file.ts"), "ignored\n", "utf8");
  return repositoryPath;
}

test("readGitState returns the commit, the branch and the state of each file", async () => {
  const repositoryPath = await createRepository();
  const commit = git(repositoryPath, ["rev-parse", "HEAD"]);
  const gitState = (state: Pick<FusenGitState, "staged" | "unstaged" | "untracked">): FusenGitState => ({
    commit,
    branch: "main",
    ...state,
  });

  assert.deepEqual(await readGitState(repositoryPath, "committed.ts"), gitState({ staged: false, unstaged: false, untracked: false }));
  assert.deepEqual(await readGitState(repositoryPath, "staged.ts"), gitState({ staged: true, unstaged: false, untracked: false }));
  assert.deepEqual(await readGitState(repositoryPath, "unstaged.ts"), gitState({ staged: false, unstaged: true, untracked: false }));
  assert.deepEqual(await readGitState(repositoryPath, "both.ts"), gitState({ staged: true, unstaged: true, untracked: false }));
  assert.deepEqual(await readGitState(repositoryPath, "untracked.ts"), gitState({ staged: false, unstaged: false, untracked: true }));
  assert.deepEqual(await readGitState(repositoryPath, "ignored/file.ts"), gitState({ staged: false, unstaged: false, untracked: true }));
  // `[a]` would be a pattern matching `a` if the path were not taken literally.
  assert.deepEqual(await readGitState(repositoryPath, "src/[a].ts"), gitState({ staged: false, unstaged: false, untracked: false }));
});

test("readGitState reads the repository that holds the file when the workspace folder is inside it or contains it", async () => {
  const repositoryPath = await createRepository();
  const commit = git(repositoryPath, ["rev-parse", "HEAD"]);
  assert.deepEqual(await readGitState(path.join(repositoryPath, "src"), "[a].ts"), {
    commit,
    branch: "main",
    staged: false,
    unstaged: false,
    untracked: false,
  });
  assert.deepEqual(await readGitState(path.dirname(repositoryPath), `${path.basename(repositoryPath)}/unstaged.ts`), {
    commit,
    branch: "main",
    staged: false,
    unstaged: true,
    untracked: false,
  });
});

test("readGitState omits the branch on a detached HEAD", async () => {
  const repositoryPath = await createRepository();
  const commit = git(repositoryPath, ["rev-parse", "HEAD"]);
  git(repositoryPath, ["checkout", "--detach"]);
  assert.deepEqual(await readGitState(repositoryPath, "committed.ts"), {
    commit,
    staged: false,
    unstaged: false,
    untracked: false,
  });
});

test("readGitState returns undefined outside a git repository, before the first commit and for a missing directory", async () => {
  const directoryPath = await createDirectory({ "sample.ts": "sample\n" });
  assert.equal(await readGitState(directoryPath, "sample.ts"), undefined);
  git(directoryPath, ["init", "--initial-branch=main"]);
  assert.equal(await readGitState(directoryPath, "sample.ts"), undefined);
  assert.equal(await readGitState(directoryPath, "missing/sample.ts"), undefined);
});

test("parseGitState keeps the known fields and rejects values that are not a git state", () => {
  const gitState: FusenGitState = {
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    staged: false,
    unstaged: true,
    untracked: false,
  };
  assert.deepEqual(parseGitState({ ...gitState, extra: true }), gitState);
  assert.equal("branch" in parseGitState({ ...gitState, branch: undefined }), false);
  const sha256Commit = { ...gitState, commit: "0123456789abcdef".repeat(4) };
  assert.deepEqual(parseGitState(sha256Commit), sha256Commit);

  const invalidValues: unknown[] = [
    null,
    [],
    "0123456789abcdef0123456789abcdef01234567",
    { ...gitState, commit: "0123456" },
    { ...gitState, commit: "0123456789ABCDEF0123456789ABCDEF01234567" },
    { ...gitState, commit: "(initial)" },
    { ...gitState, commit: undefined },
    { ...gitState, branch: "" },
    { ...gitState, branch: 1 },
    { ...gitState, staged: "false" },
    { ...gitState, unstaged: undefined },
    { ...gitState, untracked: 0 },
  ];
  for (const value of invalidValues) {
    assert.throws(() => parseGitState(value), Error, JSON.stringify(value));
  }
});

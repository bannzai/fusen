import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "./files.js";

/** The git state of a commented file when a comment was posted, stored as the comment's `git`. */
export interface FusenGitState {
  /** SHA of the commit `HEAD` pointed to. */
  commit: string;
  /** Name of the branch checked out. Omitted on a detached `HEAD`. */
  branch?: string;
  /** Whether the index had changes to the file that `HEAD` does not have. */
  staged: boolean;
  /** Whether the file on disk had changes that the index does not have. */
  unstaged: boolean;
  /** Whether git did not track the file, including a file that git ignores. */
  untracked: boolean;
}

// 40 hexadecimal digits in a SHA-1 repository and 64 in a SHA-256 one (https://git-scm.com/docs/hash-function-transition).
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// A `git status` limited to one file normally finishes well within a second. The limit keeps a git that hangs,
// for example on a slow network file system, from holding up the comment, which is then saved without `git`.
const gitStatusTimeoutMs = 10_000;

/** Validates parsed JSON as the git state of a comment and returns it with only the known fields. Throws when it is not valid. */
export function parseGitState(value: unknown): FusenGitState {
  if (!isRecord(value)) {
    throw new Error("A git state must be an object");
  }
  if (typeof value.commit !== "string" || !commitPattern.test(value.commit)) {
    throw new Error(`Invalid git commit: ${JSON.stringify(value.commit)}`);
  }
  if (value.branch !== undefined && (typeof value.branch !== "string" || value.branch === "")) {
    throw new Error(`Invalid git branch: ${JSON.stringify(value.branch)}`);
  }
  if (typeof value.staged !== "boolean" || typeof value.unstaged !== "boolean" || typeof value.untracked !== "boolean") {
    throw new Error("staged, unstaged and untracked of a git state must be booleans");
  }
  return {
    commit: value.commit,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    staged: value.staged,
    unstaged: value.unstaged,
    untracked: value.untracked,
  };
}

/**
 * Returns the git state of `file`, a path relative to the workspace folder at `workspaceRoot`, as it is now.
 * git runs in the file's directory, so a file in a repository nested in the workspace folder gets that repository's state.
 * Returns `undefined` when the file is not in a git repository, the repository has no commit yet, git is not installed,
 * or git fails, so that saving a comment never fails because of git.
 */
export async function readGitState(workspaceRoot: string, file: string): Promise<FusenGitState | undefined> {
  const filePath = path.join(workspaceRoot, ...file.split("/"));
  try {
    const { stdout } = await promisify(execFile)(
      "git",
      [
        // Leaves the index alone, so that git running at the same time, such as the editor's, does not find it locked.
        "--no-optional-locks",
        // A file name such as `[a].ts` names that file rather than a pattern.
        "--literal-pathspecs",
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        // Lists an untracked or ignored file itself even when its whole directory is untracked or ignored.
        "--untracked-files=all",
        "--ignored",
        "--",
        path.basename(filePath),
      ],
      { cwd: path.dirname(filePath), encoding: "utf8", timeout: gitStatusTimeoutMs },
    );
    // The commit of a repository without commits reads `(initial)`, which parseGitState rejects.
    return parseGitState(gitStateOfStatus(stdout));
  } catch {
    return undefined;
  }
}

/**
 * Returns the fields of a git state read from `statusOutput`, the output of
 * `git status --porcelain=v2 --branch -z` (https://git-scm.com/docs/git-status#_porcelain_format_version_2) limited to one file.
 */
function gitStateOfStatus(statusOutput: string): Record<string, unknown> {
  let commit: string | undefined;
  let branch: string | undefined;
  let staged = false;
  let unstaged = false;
  let untracked = false;
  const records = statusOutput.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record.startsWith("# branch.oid ")) {
      commit = record.slice("# branch.oid ".length);
    } else if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      branch = head === "(detached)" ? undefined : head;
    } else if (/^[12u] /.test(record)) {
      // `XY` is the state of the file in the index and in the working tree, with `.` for unchanged.
      staged ||= record[2] !== ".";
      unstaged ||= record[3] !== ".";
      if (record.startsWith("2 ")) {
        // A renamed or copied file is followed by its original path as a record of its own.
        index++;
      }
    } else if (record.startsWith("? ") || record.startsWith("! ")) {
      untracked = true;
    }
  }
  return { commit, ...(branch === undefined ? {} : { branch }), staged, unstaged, untracked };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FusenThread } from "./threads.js";

/** Returns the path of `.fusen/prompt.md`, the file the prompt of the workspace folder at `workspaceRoot` is exported to. */
export function promptFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".fusen", "prompt.md");
}

/** Writes `prompt` to `.fusen/prompt.md` of the workspace folder at `workspaceRoot`, replacing the previous export. */
export async function writePrompt(workspaceRoot: string, prompt: string): Promise<void> {
  const filePath = promptFilePath(workspaceRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, prompt, "utf8");
}

/**
 * Returns one markdown prompt that hands `threads` of the workspace folder at `workspaceRoot` to an AI agent.
 * Threads are ordered by file and line, and each one carries its file path, line range,
 * the code of those lines as it is on disk now, and every comment in posting order.
 */
export async function createPrompt(workspaceRoot: string, threads: readonly FusenThread[]): Promise<string> {
  const sortedThreads = [...threads].sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.startLine - right.startLine || left.endLine - right.endLine,
  );
  // Several threads on one file read it once.
  const fileLines = new Map<string, string[] | undefined>();
  const sections: string[] = [];
  for (const thread of sortedThreads) {
    if (!fileLines.has(thread.file)) {
      fileLines.set(thread.file, await readLines(path.join(workspaceRoot, ...thread.file.split("/"))));
    }
    sections.push(threadSection(thread, fileLines.get(thread.file)));
  }
  const fileCount = new Set(threads.map((thread) => thread.file)).size;
  return [
    "# Fusen comments",
    threads.length === 0
      ? "There are no comments."
      : `${countText(threads.length, "comment thread")} on ${countText(fileCount, "file")}. Each section is a line range of a file, the code on those lines, and the comments on it in posting order. Paths are relative to the workspace root and line numbers start at 1.`,
    ...sections,
  ].join("\n\n") + "\n";
}

/** Returns the markdown section of `thread`, given the lines of its file, or `undefined` when the file cannot be read. */
function threadSection(thread: FusenThread, lines: string[] | undefined): string {
  const lineRange = thread.startLine === thread.endLine ? `${thread.startLine}` : `${thread.startLine}-${thread.endLine}`;
  return [
    `## ${thread.file}:${lineRange}`,
    lines === undefined
      ? "_The file could not be read._"
      : thread.startLine > lines.length
        ? `_The file has only ${countText(lines.length, "line")}._`
        : codeBlock(lines.slice(thread.startLine - 1, thread.endLine).join("\n"), path.posix.extname(thread.file).slice(1)),
    ...thread.comments.map((comment) => `**${comment.author === "human" ? "Human" : "Agent"}:**\n\n${comment.body}`),
  ].join("\n\n");
}

/** Returns `code` in a fenced code block whose fence is longer than any backtick run inside the code. */
function codeBlock(code: string, language: string): string {
  const longestBacktickRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((backticks) => backticks.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

/** Returns the lines of the file at `filePath`, or `undefined` when it cannot be read, for example after it was deleted. */
async function readLines(filePath: string): Promise<string[] | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    // A final line break ends the last line rather than starting an empty one.
    return text.replace(/\r?\n$/, "").split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** Returns `count` followed by `noun`, pluralized with "s" unless `count` is 1. */
function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

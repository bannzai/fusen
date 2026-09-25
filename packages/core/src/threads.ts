import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { type InvalidFusenFile, fusenFilePath, fusenIdPattern, isRecord, readFusenDirectory, writeFusenFile } from "./files.js";

/** Who wrote a comment: the person using the editor, or an AI agent writing over MCP. */
export type FusenCommentAuthor = "human" | "agent";

/** One comment in a thread. */
export interface FusenComment {
  /** Identifier unique within the thread. */
  id: string;
  /** Comment text in markdown. */
  body: string;
  /** Who wrote the comment. */
  author: FusenCommentAuthor;
  /** When the comment was created, as an ISO 8601 string. */
  createdAt: string;
}

/** A thread of comments on a line range of one file, stored as `.fusen/threads/<id>.json`. */
export interface FusenThread {
  /** Storage format version, raised when a change is not backward compatible. */
  version: 1;
  /** Identifier of the thread, which is also the file name without `.json`. */
  id: string;
  /** Path of the commented file relative to the workspace folder, with `/` separators. */
  file: string;
  /** First commented line, 1-based. */
  startLine: number;
  /** Last commented line, 1-based and inclusive. */
  endLine: number;
  /** Comments in the order they were posted. A stored thread always has at least one. */
  comments: FusenComment[];
}

/** Returns the directory that holds one JSON file per thread for the workspace folder at `workspaceRoot`. */
export function threadsDirectoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".fusen", "threads");
}

/** Returns the path of the file that stores the thread `threadId`. */
export function threadFilePath(workspaceRoot: string, threadId: string): string {
  return fusenFilePath(threadsDirectoryPath(workspaceRoot), threadId);
}

/** Returns a new identifier for a thread or a comment. */
export function createFusenId(): string {
  return randomUUID();
}

/** Validates parsed JSON as a thread and returns it with only the known fields. Throws when it is not a valid thread. */
export function parseThread(value: unknown): FusenThread {
  if (!isRecord(value)) {
    throw new Error("A thread must be an object");
  }
  if (value.version !== 1) {
    throw new Error(`Unsupported thread version: ${JSON.stringify(value.version)}`);
  }
  if (typeof value.id !== "string" || !fusenIdPattern.test(value.id)) {
    throw new Error(`Invalid thread id: ${JSON.stringify(value.id)}`);
  }
  if (typeof value.file !== "string" || !isWorkspaceRelativePath(value.file)) {
    throw new Error(`Invalid file path: ${JSON.stringify(value.file)}`);
  }
  if (!isLineNumber(value.startLine) || !isLineNumber(value.endLine) || value.endLine < value.startLine) {
    throw new Error(`Invalid line range: ${JSON.stringify(value.startLine)}-${JSON.stringify(value.endLine)}`);
  }
  if (!Array.isArray(value.comments) || value.comments.length === 0) {
    throw new Error("A thread must have at least one comment");
  }
  return {
    version: 1,
    id: value.id,
    file: value.file,
    startLine: value.startLine,
    endLine: value.endLine,
    comments: value.comments.map(parseComment),
  };
}

/**
 * Reads every thread of the workspace folder at `workspaceRoot`, sorted by file name.
 * A file that is not a valid thread is returned in `invalidFiles` instead of failing the whole read,
 * so one broken file does not hide the other threads.
 */
export async function readThreads(
  workspaceRoot: string,
): Promise<{ threads: FusenThread[]; invalidFiles: InvalidFusenFile[] }> {
  const { values, invalidFiles } = await readFusenDirectory(threadsDirectoryPath(workspaceRoot), parseThread);
  return { threads: values, invalidFiles };
}

/**
 * Writes `thread` to its file, replacing any previous content.
 * The content goes to a temporary file first and is renamed into place,
 * so a reader such as the MCP server never sees a half-written file.
 */
export async function writeThread(workspaceRoot: string, thread: FusenThread): Promise<void> {
  const validThread = parseThread(thread);
  await writeFusenFile(threadFilePath(workspaceRoot, validThread.id), validThread);
}

/** Deletes the file of the thread `threadId`. Deleting a thread that has no file succeeds. */
export async function deleteThread(workspaceRoot: string, threadId: string): Promise<void> {
  await rm(threadFilePath(workspaceRoot, threadId), { force: true });
}

/** Validates parsed JSON as a comment and returns it with only the known fields. */
export function parseComment(value: unknown): FusenComment {
  if (!isRecord(value)) {
    throw new Error("A comment must be an object");
  }
  if (typeof value.id !== "string" || !fusenIdPattern.test(value.id)) {
    throw new Error(`Invalid comment id: ${JSON.stringify(value.id)}`);
  }
  if (typeof value.body !== "string") {
    throw new Error(`Comment ${value.id} has no body`);
  }
  if (value.author !== "human" && value.author !== "agent") {
    throw new Error(`Comment ${value.id} has an invalid author: ${JSON.stringify(value.author)}`);
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error(`Comment ${value.id} has an invalid createdAt: ${JSON.stringify(value.createdAt)}`);
  }
  return { id: value.id, body: value.body, author: value.author, createdAt: value.createdAt };
}

/** Returns whether `value` is a 1-based line number. */
function isLineNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

/** Returns whether `filePath` stays inside the workspace folder and does not depend on the OS separator. */
function isWorkspaceRelativePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\\") &&
    !path.posix.isAbsolute(filePath) &&
    !/^[A-Za-z]:/.test(filePath) &&
    filePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

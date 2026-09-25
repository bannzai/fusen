import { rm } from "node:fs/promises";
import path from "node:path";
import {
  type InvalidFusenFile,
  fileExists,
  fusenFilePath,
  fusenIdPattern,
  isRecord,
  readFusenDirectory,
  writeFusenFile,
} from "./files.js";
import { type FusenComment, type FusenThread, parseComment, parseThread, readThreads } from "./threads.js";

/** An agent's proposal to add a comment to an existing thread, stored as `.fusen/_pending/<id>.json`. */
export interface FusenPendingReply {
  /** Storage format version, the same as the thread format's. */
  version: 1;
  /** Identifier of the proposal, which is also the file name without `.json` and the id of `comment`. */
  id: string;
  /** Identifier of the thread the comment is proposed for. */
  threadId: string;
  /** The proposed comment, written by an agent. Its id equals the proposal id so that it can be found after approval. */
  comment: FusenComment;
}

/**
 * A comment an agent wrote over MCP that waits in `.fusen/_pending/` until a human approves or rejects it.
 * A new thread has the shape of a thread with only agent comments, and its id becomes the thread id on approval.
 */
export type FusenPendingProposal = FusenThread | FusenPendingReply;

/**
 * Where a proposal stands: still waiting in `.fusen/_pending/`, approved into a thread, or neither.
 * Rejecting deletes the proposal without a record, so a proposal that was approved and whose thread or comment
 * was deleted afterwards also reads as rejected.
 */
export type FusenProposalStatus = "pending" | "approved" | "rejected";

/** Returns the directory that holds one JSON file per pending proposal for the workspace folder at `workspaceRoot`. */
export function pendingDirectoryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".fusen", "_pending");
}

/** Returns the path of the file that stores the pending proposal `proposalId`. */
export function pendingProposalFilePath(workspaceRoot: string, proposalId: string): string {
  return fusenFilePath(pendingDirectoryPath(workspaceRoot), proposalId);
}

/** Returns whether `proposal` adds a comment to an existing thread rather than starting a new one. */
export function isPendingReply(proposal: FusenPendingProposal): proposal is FusenPendingReply {
  return "threadId" in proposal;
}

/** Validates parsed JSON as a pending proposal and returns it with only the known fields. Throws when it is not valid. */
export function parsePendingProposal(value: unknown): FusenPendingProposal {
  if (!isRecord(value) || !("threadId" in value)) {
    const thread = parseThread(value);
    if (thread.comments.some((comment) => comment.author !== "agent")) {
      throw new Error("Every comment of a proposed thread must be written by an agent");
    }
    return thread;
  }
  if (value.version !== 1) {
    throw new Error(`Unsupported proposal version: ${JSON.stringify(value.version)}`);
  }
  if (typeof value.id !== "string" || !fusenIdPattern.test(value.id)) {
    throw new Error(`Invalid proposal id: ${JSON.stringify(value.id)}`);
  }
  if (typeof value.threadId !== "string" || !fusenIdPattern.test(value.threadId)) {
    throw new Error(`Invalid thread id: ${JSON.stringify(value.threadId)}`);
  }
  const comment = parseComment(value.comment);
  if (comment.id !== value.id) {
    throw new Error(`The proposed comment id ${comment.id} does not match the proposal id ${value.id}`);
  }
  if (comment.author !== "agent") {
    throw new Error("A proposed comment must be written by an agent");
  }
  return { version: 1, id: value.id, threadId: value.threadId, comment };
}

/**
 * Reads every pending proposal of the workspace folder at `workspaceRoot`, sorted by file name.
 * A file that is not a valid proposal is returned in `invalidFiles` instead of failing the whole read.
 */
export async function readPendingProposals(
  workspaceRoot: string,
): Promise<{ proposals: FusenPendingProposal[]; invalidFiles: InvalidFusenFile[] }> {
  const { values, invalidFiles } = await readFusenDirectory(pendingDirectoryPath(workspaceRoot), parsePendingProposal);
  return { proposals: values, invalidFiles };
}

/** Writes `proposal` to its file in `.fusen/_pending/`, replacing any previous content, without touching the threads. */
export async function writePendingProposal(workspaceRoot: string, proposal: FusenPendingProposal): Promise<void> {
  const validProposal = parsePendingProposal(proposal);
  await writeFusenFile(pendingProposalFilePath(workspaceRoot, validProposal.id), validProposal);
}

/** Deletes the file of the pending proposal `proposalId`. Deleting a proposal that has no file succeeds. */
export async function deletePendingProposal(workspaceRoot: string, proposalId: string): Promise<void> {
  await rm(pendingProposalFilePath(workspaceRoot, proposalId), { force: true });
}

/**
 * Returns whether the proposal `proposalId` is already in `threads`.
 * An approved new thread keeps the proposal id as its thread id, and an approved reply keeps it as its comment id.
 */
export function isProposalInThreads(threads: readonly FusenThread[], proposalId: string): boolean {
  return threads.some((thread) => thread.id === proposalId || thread.comments.some((comment) => comment.id === proposalId));
}

/**
 * Returns where the proposal `proposalId` stands.
 * A proposal that is in a thread reads as approved even while its file is still in `.fusen/_pending/`,
 * because an approval that stopped between writing the thread and deleting the proposal has already taken effect.
 */
export async function readProposalStatus(workspaceRoot: string, proposalId: string): Promise<FusenProposalStatus> {
  // Resolving the path first rejects an id that could escape the directory before anything is read.
  const proposalFilePath = pendingProposalFilePath(workspaceRoot, proposalId);
  if (isProposalInThreads((await readThreads(workspaceRoot)).threads, proposalId)) {
    return "approved";
  }
  if (await fileExists(proposalFilePath)) {
    return "pending";
  }
  // An approval that finished between the two reads above wrote the thread before it deleted the proposal,
  // so reading the threads again tells it apart from a rejection.
  return isProposalInThreads((await readThreads(workspaceRoot)).threads, proposalId) ? "approved" : "rejected";
}

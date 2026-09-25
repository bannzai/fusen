import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type FusenComment,
  type FusenPendingProposal,
  type FusenProposalStatus,
  codeAt,
  createFusenId,
  createPrompt,
  isPendingReply,
  isWorkspaceRelativePath,
  parseThread,
  readPendingProposals,
  readGitState,
  readProposalStatus,
  readThreads,
  writePendingProposal,
} from "fusen-core";
import { z } from "zod";

/** Input of the read tools that names a file, rejected before anything is read when it could not be the `file` of a thread. */
const workspaceFileSchema = z
  .string()
  .refine(isWorkspaceRelativePath, { message: "file must be a path relative to the workspace folder, with / separators" })
  .describe("Path of the file relative to the workspace folder, with / separators");

/** Structured output of the tools that write or check a proposal: a proposal and where it stands, with the values of `FusenProposalStatus`. */
const proposalOutputSchema = {
  proposalId: z.string().describe("Id of the proposal, to pass to get_proposal_status"),
  status: z
    .enum(["pending", "approved", "rejected"])
    .describe("pending while the proposal waits in .fusen/_pending/, approved once it is in a thread, rejected otherwise"),
};

/**
 * Creates the Fusen MCP server for the workspace folder at `workspaceRoot`.
 * Agents write only to `.fusen/_pending/`; a human approves or rejects each proposal in the editor.
 */
export function createServer(workspaceRoot: string): McpServer {
  const server = new McpServer({ name: "fusen", version: "0.2.0" });

  server.registerTool(
    "post_comment",
    {
      title: "Post a comment on lines",
      description:
        "Proposes a new Fusen comment thread on a line range of a file in the workspace. " +
        "The comment appears in the editor only after a human approves it.",
      inputSchema: {
        file: z.string().describe("Path of the file relative to the workspace folder, with / separators"),
        startLine: z.number().int().min(1).describe("First line of the range, 1-based"),
        endLine: z.number().int().min(1).optional().describe("Last line of the range, 1-based and inclusive. Defaults to startLine"),
        body: z.string().min(1).describe("Comment text in markdown"),
      },
      outputSchema: proposalOutputSchema,
    },
    async ({ file, startLine, endLine, body }) => {
      // parseThread rejects paths outside the workspace folder and reversed ranges before the file is read or git runs on it.
      const thread = parseThread({
        version: 1,
        id: createFusenId(),
        file,
        startLine,
        endLine: endLine ?? startLine,
        comments: [agentComment(createFusenId(), body)],
      });
      // The code of the lines lets the editor find them again if the file changes before the proposal is approved.
      const code = codeAt(await readWorkspaceFile(workspaceRoot, thread.file), thread);
      if (!code) {
        throw new Error(`${thread.file} has no line ${thread.endLine}`);
      }
      // Approving moves the comment into a thread as it is, so the git state stays the one of the time the agent posted it.
      const git = await readGitState(workspaceRoot, thread.file);
      await writePendingProposal(workspaceRoot, { ...thread, code, comments: thread.comments.map((comment) => ({ ...comment, git })) });
      return proposalResult(thread.id, "pending");
    },
  );

  server.registerTool(
    "reply_to_thread",
    {
      title: "Reply to a thread",
      description:
        "Proposes a reply to an existing Fusen comment thread. The reply appears in the editor only after a human approves it.",
      inputSchema: {
        threadId: z.string().describe("Id of the thread, the file name of .fusen/threads/<id>.json without .json"),
        body: z.string().min(1).describe("Comment text in markdown"),
      },
      outputSchema: proposalOutputSchema,
    },
    async ({ threadId, body }) => {
      const thread = (await readThreads(workspaceRoot)).threads.find((storedThread) => storedThread.id === threadId);
      if (!thread) {
        throw new Error(`Thread ${threadId} does not exist`);
      }
      // The comment takes the proposal id so that the approved comment can be found by get_proposal_status.
      const proposalId = createFusenId();
      await writePendingProposal(workspaceRoot, {
        version: 1,
        id: proposalId,
        threadId,
        comment: { ...agentComment(proposalId, body), git: await readGitState(workspaceRoot, thread.file) },
      });
      return proposalResult(proposalId, "pending");
    },
  );

  server.registerTool(
    "get_proposal_status",
    {
      title: "Get the approval status of a proposal",
      description:
        "Returns whether a comment posted with post_comment or reply_to_thread is pending, approved or rejected. " +
        "A proposal whose approved thread or comment was deleted afterwards also reads as rejected.",
      inputSchema: {
        proposalId: z.string().describe("proposalId returned by post_comment or reply_to_thread"),
      },
      outputSchema: proposalOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ proposalId }) => proposalResult(proposalId, await readProposalStatus(workspaceRoot, proposalId)),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "Returns the comment threads of the workspace (status open, stored in .fusen/threads/) and the comments agents proposed " +
        "that wait for a human's approval (status pending, stored in .fusen/_pending/), optionally only those on one file or with one status. " +
        "Files under .fusen/ that cannot be read as a thread or a proposal are listed in invalidFiles.",
      inputSchema: {
        file: workspaceFileSchema.optional(),
        status: z
          .enum(["open", "pending"])
          .optional()
          .describe("open for threads a human can see in the editor, pending for proposals waiting for approval. Both when omitted"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ file, status }) => readCommentsResult(workspaceRoot, file, status),
  );

  server.registerTool(
    "get_file_comments",
    {
      title: "Get the comments on a file",
      description:
        "Returns the comment threads on one file of the workspace and the comments agents proposed on it that wait for a human's approval, " +
        "in the same shape as list_comments.",
      inputSchema: { file: workspaceFileSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => readCommentsResult(workspaceRoot, file, undefined),
  );

  server.registerTool(
    "get_prompt",
    {
      title: "Get the comments as a prompt",
      description:
        "Returns the comment threads of the workspace, or only those on one file, as one markdown prompt with the code of each commented line range. " +
        "It is the same markdown as the editor's Fusen: Copy comments as prompt command. Proposals waiting for approval are not included.",
      inputSchema: { file: workspaceFileSchema.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      const { threads, invalidFiles } = await readThreads(workspaceRoot);
      return {
        content: [
          {
            type: "text",
            text: await createPrompt(workspaceRoot, file === undefined ? threads : threads.filter((thread) => thread.file === file)),
          },
          // The editor warns about each skipped file; the agent is told in a separate block so that the prompt stays the same.
          ...invalidFiles.map((invalidFile) => ({
            type: "text" as const,
            text: `Skipped ${invalidFile.path}: ${invalidFile.message}`,
          })),
        ],
      };
    },
  );

  return server;
}

/**
 * Returns the tool result of the threads and the pending proposals of the workspace folder at `workspaceRoot`,
 * only those on `file` when it is given and only those with `status` when it is given, as JSON text and as structured content.
 */
async function readCommentsResult(
  workspaceRoot: string,
  file: string | undefined,
  status: "open" | "pending" | undefined,
): Promise<CallToolResult> {
  // The threads are read for pending proposals too, because a proposed reply names its thread instead of a file.
  const threadsRead = await readThreads(workspaceRoot);
  const pendingRead: Awaited<ReturnType<typeof readPendingProposals>> =
    status === "open" ? { proposals: [], invalidFiles: [] } : await readPendingProposals(workspaceRoot);
  const proposalFile = (proposal: FusenPendingProposal) =>
    isPendingReply(proposal) ? threadsRead.threads.find((thread) => thread.id === proposal.threadId)?.file : proposal.file;
  const comments = {
    threads: status === "pending" ? [] : threadsRead.threads.filter((thread) => file === undefined || thread.file === file),
    pendingProposals: pendingRead.proposals.filter((proposal) => file === undefined || proposalFile(proposal) === file),
    invalidFiles: [...(status === "pending" ? [] : threadsRead.invalidFiles), ...pendingRead.invalidFiles],
  };
  return { content: [{ type: "text", text: JSON.stringify(comments) }], structuredContent: comments };
}

/** Returns a new comment written by an agent with the id `commentId`. */
function agentComment(commentId: string, body: string): FusenComment {
  return { id: commentId, body, author: "agent", createdAt: new Date().toISOString() };
}

/** Returns the tool result that reports `status` of the proposal `proposalId` as text and as structured content. */
function proposalResult(proposalId: string, status: FusenProposalStatus): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ proposalId, status }) }],
    structuredContent: { proposalId, status },
  };
}

/** Returns the text of `file` in the workspace folder at `workspaceRoot`, with an error message that names the file. */
async function readWorkspaceFile(workspaceRoot: string, file: string): Promise<string> {
  return readFile(path.join(workspaceRoot, file), "utf8").catch((error: unknown) => {
    throw new Error(`${file} cannot be read: ${isErrnoException(error) && error.code === "ENOENT" ? "the file does not exist" : String(error)}`);
  });
}

/** Returns whether `error` is a Node.js system error that carries a `code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

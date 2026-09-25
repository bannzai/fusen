import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type FusenComment,
  type FusenProposalStatus,
  createFusenId,
  parseThread,
  readProposalStatus,
  readThreads,
  writePendingProposal,
} from "fusen-core";
import { z } from "zod";

/** Structured output of every tool: a proposal and where it stands, with the values of `FusenProposalStatus`. */
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
  const server = new McpServer({ name: "fusen", version: "0.0.1" });

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
      // parseThread rejects paths outside the workspace folder and reversed ranges before the file is read.
      const thread = parseThread({
        version: 1,
        id: createFusenId(),
        file,
        startLine,
        endLine: endLine ?? startLine,
        comments: [agentComment(createFusenId(), body)],
      });
      const lineCount = await countLines(workspaceRoot, thread.file);
      if (thread.endLine > lineCount) {
        throw new Error(`${thread.file} has ${lineCount} lines, so line ${thread.endLine} does not exist`);
      }
      await writePendingProposal(workspaceRoot, thread);
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
      if (!(await readThreads(workspaceRoot)).threads.some((thread) => thread.id === threadId)) {
        throw new Error(`Thread ${threadId} does not exist`);
      }
      // The comment takes the proposal id so that the approved comment can be found by get_proposal_status.
      const proposalId = createFusenId();
      await writePendingProposal(workspaceRoot, { version: 1, id: proposalId, threadId, comment: agentComment(proposalId, body) });
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

  return server;
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

/**
 * Returns the number of lines of `file` in the workspace folder at `workspaceRoot`,
 * counted as the editor does, so a trailing newline adds an empty last line.
 */
async function countLines(workspaceRoot: string, file: string): Promise<number> {
  const text = await readFile(path.join(workspaceRoot, file), "utf8").catch((error: unknown) => {
    throw new Error(`${file} cannot be read: ${isErrnoException(error) && error.code === "ENOENT" ? "the file does not exist" : String(error)}`);
  });
  return text.split(/\r\n|\r|\n/).length;
}

/** Returns whether `error` is a Node.js system error that carries a `code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

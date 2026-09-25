import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type FusenThread, deletePendingProposal, isPendingReply, readPendingProposals, readThreads, writeThread } from "fusen-core";

/** Structured content that every Fusen tool returns. */
interface ProposalOutput {
  /** Id of the proposal in `.fusen/_pending/`. */
  proposalId: string;
  /** Where the proposal stands. */
  status: string;
}

/** Starts the stdio server with `workspaceRoot` as its working directory and returns a client connected to it. */
async function connectClient(workspaceRoot?: string): Promise<Client> {
  const client = new Client({ name: "fusen-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./index.js", import.meta.url))],
      cwd: workspaceRoot,
    }),
  );
  return client;
}

/** Calls the tool `name` and returns its structured content, failing when the call reports an error. */
async function callProposalTool(client: Client, name: string, toolArguments: Record<string, unknown>): Promise<ProposalOutput> {
  const result = await client.callTool({ name, arguments: toolArguments });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent as unknown as ProposalOutput;
}

/** Creates a temporary directory that stands in for a workspace folder, holding `src/sample.ts` with three lines of code. */
async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "fusen-mcp-"));
  await mkdir(path.join(workspaceRoot, "src"));
  await writeFile(
    path.join(workspaceRoot, "src", "sample.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "utf8",
  );
  return workspaceRoot;
}

test("the stdio server completes the MCP handshake as fusen", async () => {
  const client = await connectClient();
  try {
    assert.equal(client.getServerVersion()?.name, "fusen");
  } finally {
    await client.close();
  }
});

test("post_comment puts a proposed thread in .fusen/_pending/ and rejects lines that do not exist", async () => {
  const workspaceRoot = await createWorkspace();
  const client = await connectClient(workspaceRoot);
  try {
    const output = await callProposalTool(client, "post_comment", {
      file: "src/sample.ts",
      startLine: 1,
      endLine: 3,
      body: "Rename add to sum",
    });
    assert.equal(output.status, "pending");

    const { proposals, invalidFiles } = await readPendingProposals(workspaceRoot);
    assert.deepEqual(invalidFiles, []);
    const [proposal] = proposals;
    assert.ok(proposal && !isPendingReply(proposal) && proposals.length === 1);
    assert.deepEqual(
      { ...proposal, comments: proposal.comments.map(({ body, author }) => ({ body, author })) },
      {
        version: 1,
        id: output.proposalId,
        file: "src/sample.ts",
        startLine: 1,
        endLine: 3,
        code: ["export function add(a: number, b: number): number {", "  return a + b;", "}"],
        comments: [{ body: "Rename add to sum", author: "agent" }],
      },
    );
    assert.deepEqual(await readThreads(workspaceRoot), { threads: [], invalidFiles: [] });

    const invalidArguments = [
      // The file has three lines of code and the empty fourth line after the final newline.
      { file: "src/sample.ts", startLine: 5, body: "Past the end" },
      { file: "src/sample.ts", startLine: 2, endLine: 9, body: "Range past the end" },
      { file: "src/sample.ts", startLine: 3, endLine: 2, body: "Reversed range" },
      { file: "src/missing.ts", startLine: 1, body: "No such file" },
      { file: "../outside.ts", startLine: 1, body: "Outside the workspace" },
    ];
    for (const invalidArgument of invalidArguments) {
      const result = await client.callTool({ name: "post_comment", arguments: invalidArgument });
      assert.equal(result.isError, true, JSON.stringify(invalidArgument));
    }
    assert.equal((await readPendingProposals(workspaceRoot)).proposals.length, 1);
  } finally {
    await client.close();
  }
});

test("reply_to_thread puts a proposed reply in .fusen/_pending/ and get_proposal_status follows the human's decision", async () => {
  const workspaceRoot = await createWorkspace();
  const thread: FusenThread = {
    version: 1,
    id: "thread-a",
    file: "src/sample.ts",
    startLine: 2,
    endLine: 2,
    comments: [{ id: "c1", body: "Can this overflow?", author: "human", createdAt: new Date().toISOString() }],
  };
  await writeThread(workspaceRoot, thread);
  const client = await connectClient(workspaceRoot);
  try {
    const { proposalId } = await callProposalTool(client, "reply_to_thread", { threadId: "thread-a", body: "No, it adds numbers" });
    const { proposals } = await readPendingProposals(workspaceRoot);
    const [proposal] = proposals;
    assert.ok(proposal && isPendingReply(proposal) && proposals.length === 1);
    assert.deepEqual(
      { ...proposal, comment: { ...proposal.comment, createdAt: undefined } },
      {
        version: 1,
        id: proposalId,
        threadId: "thread-a",
        comment: { id: proposalId, body: "No, it adds numbers", author: "agent", createdAt: undefined },
      },
    );
    assert.deepEqual((await readThreads(workspaceRoot)).threads, [thread]);
    assert.equal((await client.callTool({ name: "reply_to_thread", arguments: { threadId: "missing", body: "Hello" } })).isError, true);

    const readStatus = async (id: string) => (await callProposalTool(client, "get_proposal_status", { proposalId: id })).status;
    assert.equal(await readStatus(proposalId), "pending");
    // Approving appends the comment to its thread and deletes the proposal, as the extension does.
    await writeThread(workspaceRoot, { ...thread, comments: [...thread.comments, proposal.comment] });
    await deletePendingProposal(workspaceRoot, proposalId);
    assert.equal(await readStatus(proposalId), "approved");

    // Rejecting deletes the proposal.
    const rejected = await callProposalTool(client, "post_comment", { file: "src/sample.ts", startLine: 1, body: "Rejected" });
    await deletePendingProposal(workspaceRoot, rejected.proposalId);
    assert.equal(await readStatus(rejected.proposalId), "rejected");
  } finally {
    await client.close();
  }
});

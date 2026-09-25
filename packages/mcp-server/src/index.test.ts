import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type FusenPendingProposal,
  type FusenThread,
  type InvalidFusenFile,
  createPrompt,
  deletePendingProposal,
  isPendingReply,
  readPendingProposals,
  readThreads,
  writePendingProposal,
  writeThread,
} from "fusen-core";

/** Structured content that the tools writing or checking a proposal return. */
interface ProposalOutput {
  /** Id of the proposal in `.fusen/_pending/`. */
  proposalId: string;
  /** Where the proposal stands. */
  status: string;
}

/** Structured content that list_comments and get_file_comments return. */
interface CommentsOutput {
  /** Threads in `.fusen/threads/`. */
  threads: FusenThread[];
  /** Proposals in `.fusen/_pending/`. */
  pendingProposals: FusenPendingProposal[];
  /** Files under `.fusen/` that could not be read. */
  invalidFiles: InvalidFusenFile[];
}

/** The fields of the published package.json that the tests check. */
interface PackageManifest {
  /** Command names mapped to their scripts, relative to the package directory. */
  bin: Record<string, string>;
  /** Packages installed with fusen-mcp from npm. */
  dependencies: Record<string, string>;
  /** Packages used only to build and test fusen-mcp. */
  devDependencies: Record<string, string>;
}

const packageDirectoryPath = fileURLToPath(new URL("..", import.meta.url));
const packageManifest = JSON.parse(await readFile(path.join(packageDirectoryPath, "package.json"), "utf8")) as PackageManifest;
// The tests start the bundled script that `npx fusen-mcp` runs, not the tsc output next to this file.
const binPath = path.join(packageDirectoryPath, packageManifest.bin["fusen-mcp"] ?? "");

/**
 * Starts the stdio server with `workspaceRoot` as its working directory, `args` after the script
 * and `env` added to the SDK's default environment, and returns a client connected to it.
 */
async function connectClient(
  workspaceRoot?: string,
  { args = [], env }: { args?: string[]; env?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client({ name: "fusen-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [binPath, ...args],
      cwd: workspaceRoot,
      // A given env replaces the default environment instead of extending it.
      env: env && { ...getDefaultEnvironment(), ...env },
    }),
  );
  return client;
}

/** Calls list_comments or get_file_comments and returns its structured content, failing when the call reports an error. */
async function callCommentsTool(client: Client, name: string, toolArguments: Record<string, unknown>): Promise<CommentsOutput> {
  const result = await client.callTool({ name, arguments: toolArguments });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return result.structuredContent as unknown as CommentsOutput;
}

/** Returns a thread with one human comment on `line` of `file`. */
function humanThread(id: string, file: string, line: number): FusenThread {
  return {
    version: 1,
    id,
    file,
    startLine: line,
    endLine: line,
    comments: [{ id: `${id}-comment`, body: `Comment of ${id}`, author: "human", createdAt: "2026-09-25T00:00:00.000Z" }],
  };
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

test("list_comments and get_file_comments read threads and pending proposals, filtered by file and status", async () => {
  const workspaceRoot = await createWorkspace();
  const sampleThread = humanThread("thread-a", "src/sample.ts", 2);
  const otherThread = humanThread("thread-b", "src/other.ts", 1);
  const proposedThread: FusenPendingProposal = {
    version: 1,
    id: "proposal-c",
    file: "src/sample.ts",
    startLine: 1,
    endLine: 1,
    comments: [{ id: "proposal-c-comment", body: "Proposed thread", author: "agent", createdAt: "2026-09-25T00:00:00.000Z" }],
  };
  const proposedReply: FusenPendingProposal = {
    version: 1,
    id: "proposal-d",
    threadId: "thread-b",
    comment: { id: "proposal-d", body: "Proposed reply", author: "agent", createdAt: "2026-09-25T00:00:00.000Z" },
  };
  await writeThread(workspaceRoot, sampleThread);
  await writeThread(workspaceRoot, otherThread);
  await writePendingProposal(workspaceRoot, proposedThread);
  await writePendingProposal(workspaceRoot, proposedReply);
  await writeFile(path.join(workspaceRoot, ".fusen", "threads", "broken.json"), "{", "utf8");
  const client = await connectClient(workspaceRoot);
  try {
    const listComments = async (toolArguments: Record<string, unknown>) => {
      const { invalidFiles, ...comments } = await callCommentsTool(client, "list_comments", toolArguments);
      // The server reads the workspace through its working directory, which can be a different spelling of the same folder (macOS /private/var).
      return { ...comments, invalidFiles: invalidFiles.map((invalidFile) => path.basename(invalidFile.path)) };
    };
    assert.deepEqual(await listComments({}), {
      threads: [sampleThread, otherThread],
      pendingProposals: [proposedThread, proposedReply],
      invalidFiles: ["broken.json"],
    });
    assert.deepEqual(await listComments({ file: "src/sample.ts" }), {
      threads: [sampleThread],
      pendingProposals: [proposedThread],
      invalidFiles: ["broken.json"],
    });
    // A proposed reply is on the file of the thread it replies to.
    assert.deepEqual(await listComments({ file: "src/other.ts" }), {
      threads: [otherThread],
      pendingProposals: [proposedReply],
      invalidFiles: ["broken.json"],
    });
    assert.deepEqual(await listComments({ status: "open" }), {
      threads: [sampleThread, otherThread],
      pendingProposals: [],
      invalidFiles: ["broken.json"],
    });
    assert.deepEqual(await listComments({ status: "pending" }), {
      threads: [],
      pendingProposals: [proposedThread, proposedReply],
      invalidFiles: [],
    });
    assert.deepEqual(await listComments({ file: "src/other.ts", status: "pending" }), {
      threads: [],
      pendingProposals: [proposedReply],
      invalidFiles: [],
    });

    const fileComments = await callCommentsTool(client, "get_file_comments", { file: "src/sample.ts" });
    assert.deepEqual(
      { threads: fileComments.threads, pendingProposals: fileComments.pendingProposals },
      { threads: [sampleThread], pendingProposals: [proposedThread] },
    );

    for (const file of ["../outside.ts", "/abs/sample.ts", "src\\sample.ts", ""]) {
      for (const name of ["list_comments", "get_file_comments"]) {
        assert.equal((await client.callTool({ name, arguments: { file } })).isError, true, `${name} ${JSON.stringify(file)}`);
      }
    }
  } finally {
    await client.close();
  }
});

test("get_prompt returns the prompt the extension exports, for every thread or those on one file", async () => {
  const workspaceRoot = await createWorkspace();
  const sampleThread = humanThread("thread-a", "src/sample.ts", 2);
  const otherThread = humanThread("thread-b", "src/other.ts", 1);
  await writeThread(workspaceRoot, sampleThread);
  await writeThread(workspaceRoot, otherThread);
  await writeFile(path.join(workspaceRoot, ".fusen", "threads", "broken.json"), "{", "utf8");
  const client = await connectClient(workspaceRoot);
  try {
    const readPrompt = async (toolArguments: Record<string, unknown>) => {
      const result = await client.callTool({ name: "get_prompt", arguments: toolArguments });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return (result.content as unknown as { type: string; text: string }[]).map((content) => content.text);
    };
    const [prompt, skippedFile, ...rest] = await readPrompt({});
    assert.equal(prompt, await createPrompt(workspaceRoot, [sampleThread, otherThread]));
    assert.match(skippedFile ?? "", /^Skipped .*broken\.json: /);
    assert.deepEqual(rest, []);
    assert.equal((await readPrompt({ file: "src/sample.ts" }))[0], await createPrompt(workspaceRoot, [sampleThread]));
    assert.equal((await client.callTool({ name: "get_prompt", arguments: { file: "../outside.ts" } })).isError, true);
  } finally {
    await client.close();
  }
});

test("the workspace folder is --workspace, then CLAUDE_PROJECT_DIR, then the working directory", async () => {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "fusen-mcp-cwd-"));
  const projectDirectory = await mkdtemp(path.join(tmpdir(), "fusen-mcp-env-"));
  const argumentDirectory = await mkdtemp(path.join(tmpdir(), "fusen-mcp-arg-"));
  const nestedDirectory = path.join(workingDirectory, "nested");
  await writeThread(workingDirectory, humanThread("in-cwd", "a.ts", 1));
  await writeThread(projectDirectory, humanThread("in-env", "a.ts", 1));
  await writeThread(argumentDirectory, humanThread("in-arg", "a.ts", 1));
  await writeThread(nestedDirectory, humanThread("in-nested", "a.ts", 1));
  const readThreadIds = async (options: { args?: string[]; env?: Record<string, string> }) => {
    const client = await connectClient(workingDirectory, options);
    try {
      return (await callCommentsTool(client, "list_comments", {})).threads.map((thread) => thread.id);
    } finally {
      await client.close();
    }
  };
  const env = { CLAUDE_PROJECT_DIR: projectDirectory };
  assert.deepEqual(await readThreadIds({ args: ["--workspace", argumentDirectory], env }), ["in-arg"]);
  assert.deepEqual(await readThreadIds({ env }), ["in-env"]);
  assert.deepEqual(await readThreadIds({}), ["in-cwd"]);
  // A relative --workspace is resolved against the working directory.
  assert.deepEqual(await readThreadIds({ args: ["--workspace", "nested"] }), ["in-nested"]);
});

test("the npm package holds the license, the README and only the bundled bin, which imports nothing but Node built-ins and its dependencies", async () => {
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json"], { cwd: packageDirectoryPath });
  const [packResult] = JSON.parse(stdout) as { files: { path: string }[] }[];
  const packedFiles = (packResult?.files ?? []).map((file) => file.path);
  for (const requiredFile of ["LICENSE", "README.md"]) {
    assert.ok(packedFiles.includes(requiredFile), `${requiredFile} is not in the package: ${packedFiles.join(", ")}`);
  }
  assert.deepEqual(
    packedFiles.filter((filePath) => /\.(map|ts)$/.test(filePath)),
    [],
    "the package contains sources or source maps",
  );
  const javaScriptFiles = packedFiles.filter((filePath) => /\.[cm]?js$/.test(filePath));
  assert.deepEqual(javaScriptFiles, [packageManifest.bin["fusen-mcp"]]);
  assert.ok(!("fusen-core" in packageManifest.dependencies) && "fusen-core" in packageManifest.devDependencies);

  const allowedModules = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const dependencyNames = Object.keys(packageManifest.dependencies);
  for (const javaScriptFile of javaScriptFiles) {
    const source = await readFile(path.join(packageDirectoryPath, javaScriptFile), "utf8");
    const importedModules = [
      ...source.matchAll(/\b(?:from\s*|import\s*|(?:require|import)\(\s*)["']([^"']+)["']/g),
    ].map((match) => match[1] ?? "");
    assert.ok(importedModules.includes("@modelcontextprotocol/sdk/server/stdio.js"), `${javaScriptFile} is not the server bundle`);
    for (const importedModule of importedModules) {
      assert.ok(
        allowedModules.has(importedModule) ||
          dependencyNames.some((name) => importedModule === name || importedModule.startsWith(`${name}/`)),
        `${javaScriptFile} imports ${importedModule}, which is not installed with fusen-mcp`,
      );
    }
  }
});

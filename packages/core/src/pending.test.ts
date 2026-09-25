import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type FusenPendingReply,
  deletePendingProposal,
  parsePendingProposal,
  pendingDirectoryPath,
  readPendingProposals,
  readProposalStatus,
  writePendingProposal,
} from "./pending.js";
import { type FusenThread, readThreads, writeThread } from "./threads.js";

/** Returns a valid proposal of a new thread with one agent comment. */
function sampleProposedThread(id: string): FusenThread {
  return {
    version: 1,
    id,
    file: "src/sample.ts",
    startLine: 3,
    endLine: 3,
    comments: [{ id: `${id}-comment`, body: "Extract a function", author: "agent", createdAt: "2026-09-25T00:00:00.000Z" }],
  };
}

/** Returns a valid proposal of a reply to the thread `threadId`. */
function sampleProposedReply(id: string, threadId: string): FusenPendingReply {
  return {
    version: 1,
    id,
    threadId,
    comment: { id, body: "Fixed in the latest change", author: "agent", createdAt: "2026-09-25T00:01:00.000Z" },
  };
}

/** Creates an empty directory that stands in for a workspace folder. */
async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "fusen-core-"));
}

test("writePendingProposal stores proposals under .fusen/_pending/ without touching the threads", async () => {
  const workspaceRoot = await createWorkspace();
  await writePendingProposal(workspaceRoot, sampleProposedThread("proposal-b"));
  await writePendingProposal(workspaceRoot, sampleProposedReply("proposal-a", "thread-a"));

  assert.deepEqual(await readdir(pendingDirectoryPath(workspaceRoot)), ["proposal-a.json", "proposal-b.json"]);
  assert.equal(
    await readFile(path.join(workspaceRoot, ".fusen", "_pending", "proposal-b.json"), "utf8"),
    `${JSON.stringify(sampleProposedThread("proposal-b"), null, 2)}\n`,
  );
  assert.deepEqual(await readPendingProposals(workspaceRoot), {
    proposals: [sampleProposedReply("proposal-a", "thread-a"), sampleProposedThread("proposal-b")],
    invalidFiles: [],
  });
  assert.deepEqual(await readThreads(workspaceRoot), { threads: [], invalidFiles: [] });
});

test("readPendingProposals reports broken files and still returns the valid proposals", async () => {
  const workspaceRoot = await createWorkspace();
  await writePendingProposal(workspaceRoot, sampleProposedThread("proposal-a"));
  await writeFile(path.join(pendingDirectoryPath(workspaceRoot), "broken.json"), "{", "utf8");

  const { proposals, invalidFiles } = await readPendingProposals(workspaceRoot);
  assert.deepEqual(proposals, [sampleProposedThread("proposal-a")]);
  assert.deepEqual(
    invalidFiles.map((invalidFile) => path.basename(invalidFile.path)),
    ["broken.json"],
  );
});

test("parsePendingProposal rejects proposals that are not written by an agent or cannot be traced after approval", () => {
  const thread = sampleProposedThread("proposal-a");
  const reply = sampleProposedReply("proposal-b", "thread-a");
  const invalidValues: unknown[] = [
    null,
    { ...thread, comments: [{ ...thread.comments[0], author: "human" }] },
    { ...reply, version: 2 },
    { ...reply, id: "../escape", comment: { ...reply.comment, id: "../escape" } },
    { ...reply, threadId: "../escape" },
    { ...reply, comment: { ...reply.comment, id: "other" } },
    { ...reply, comment: { ...reply.comment, author: "human" } },
    { ...reply, comment: undefined },
  ];
  for (const value of invalidValues) {
    assert.throws(() => parsePendingProposal(value), Error, JSON.stringify(value));
  }
});

test("readProposalStatus reads pending, approved and rejected proposals", async () => {
  const workspaceRoot = await createWorkspace();
  const approvedThread = sampleProposedThread("approved-thread");
  const approvedReply = sampleProposedReply("approved-reply", approvedThread.id);
  await writePendingProposal(workspaceRoot, approvedThread);
  await writePendingProposal(workspaceRoot, approvedReply);
  await writePendingProposal(workspaceRoot, sampleProposedThread("rejected-thread"));
  assert.equal(await readProposalStatus(workspaceRoot, approvedThread.id), "pending");
  assert.equal(await readProposalStatus(workspaceRoot, approvedReply.id), "pending");

  // Approving moves a new thread into .fusen/threads/ and appends a reply to its thread, as the extension does.
  await writeThread(workspaceRoot, { ...approvedThread, comments: [...approvedThread.comments, approvedReply.comment] });
  // An approval that stopped before deleting the proposal file has already taken effect.
  assert.equal(await readProposalStatus(workspaceRoot, approvedReply.id), "approved");
  await deletePendingProposal(workspaceRoot, approvedThread.id);
  await deletePendingProposal(workspaceRoot, approvedReply.id);
  // Rejecting deletes the proposal.
  await deletePendingProposal(workspaceRoot, "rejected-thread");

  assert.equal(await readProposalStatus(workspaceRoot, approvedThread.id), "approved");
  assert.equal(await readProposalStatus(workspaceRoot, approvedReply.id), "approved");
  assert.equal(await readProposalStatus(workspaceRoot, "rejected-thread"), "rejected");
  await assert.rejects(readProposalStatus(workspaceRoot, "../escape"));
});

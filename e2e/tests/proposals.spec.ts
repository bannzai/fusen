import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readPendingProposals, readThreads, writePendingProposal } from "fusen-core";
import { launchVSCode, vscodeStartupTimeoutMs } from "../launch";

const fixtureWorkspacePath = path.resolve(__dirname, "../fixtures/workspace");

test("proposals an agent puts in .fusen/_pending/ are shown for approval, and approving or rejecting them updates .fusen/", async ({}, testInfo) => {
  const profilePath = mkdtempSync(path.join(tmpdir(), "fusen-e2e-"));
  // A copy keeps the `.fusen/` the test writes out of the repository's fixture.
  const workspacePath = path.join(profilePath, "workspace");
  cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
  const readProposalIds = async () => (await readPendingProposals(workspacePath)).proposals.map((proposal) => proposal.id);
  const agentComment = (id: string, body: string) => ({ id, body, author: "agent" as const, createdAt: new Date().toISOString() });

  const app = await launchVSCode({ profilePath, workspacePath, filePath: path.join(workspacePath, "sample.ts") });
  try {
    const window = await app.firstWindow({ timeout: vscodeStartupTimeoutMs });
    await expect(window.locator(".statusbar-item", { hasText: "Fusen" })).toBeVisible({ timeout: 60_000 });

    // Written right after startup into a workspace without `.fusen/`, as an agent's first post over MCP creates
    // `.fusen/_pending/`, so the extension has to pick them up after its first read of the directory.
    await writePendingProposal(workspacePath, {
      version: 1,
      id: "approved-proposal",
      file: "sample.ts",
      startLine: 6,
      endLine: 6,
      comments: [agentComment("approved-comment", "Rename add to sum")],
    });
    await writePendingProposal(workspacePath, {
      version: 1,
      id: "rejected-proposal",
      file: "sample.ts",
      startLine: 2,
      endLine: 2,
      comments: [agentComment("rejected-comment", "Use single quotes")],
    });
    const approvedWidget = window.locator(".review-widget", { hasText: "Rename add to sum" });
    const rejectedWidget = window.locator(".review-widget", { hasText: "Use single quotes" });
    await expect(approvedWidget).toBeVisible({ timeout: 30_000 });
    await expect(rejectedWidget).toBeVisible();
    await expect(approvedWidget).toContainText("Pending approval");
    await expect(approvedWidget.getByRole("button", { name: "Delete Thread" })).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("proposal-pending.png") });

    await approvedWidget.getByRole("button", { name: "Approve" }).click();
    await expect.poll(readProposalIds).toEqual(["rejected-proposal"]);
    const { threads, invalidFiles } = await readThreads(workspacePath);
    expect(invalidFiles).toEqual([]);
    expect(threads).toMatchObject([
      { id: "approved-proposal", file: "sample.ts", startLine: 6, endLine: 6, comments: [{ body: "Rename add to sum", author: "agent" }] },
    ]);
    // The approved thread is a regular note: no pending label, and the actions of a note instead of approve and reject.
    await expect(approvedWidget).not.toContainText("Pending approval");
    await expect(approvedWidget.getByRole("button", { name: "Delete Thread" })).toBeVisible();
    await expect(approvedWidget.getByRole("button", { name: "Approve" })).toHaveCount(0);

    await rejectedWidget.getByRole("button", { name: "Reject" }).click();
    await expect.poll(readProposalIds).toEqual([]);
    await expect(rejectedWidget).toHaveCount(0);
    expect((await readThreads(workspacePath)).threads.map((thread) => thread.id)).toEqual(["approved-proposal"]);
    await window.screenshot({ path: testInfo.outputPath("proposal-approved.png") });

    // A proposed reply is shown at the end of the thread it replies to, and approving it appends it to the thread.
    await writePendingProposal(workspacePath, {
      version: 1,
      id: "reply-proposal",
      threadId: "approved-proposal",
      comment: agentComment("reply-proposal", "Renamed in the latest change"),
    });
    const proposedReply = approvedWidget.locator(".review-comment", { hasText: "Renamed in the latest change" });
    await expect(proposedReply).toBeVisible({ timeout: 30_000 });
    await expect(proposedReply).toContainText("Pending approval");
    await window.screenshot({ path: testInfo.outputPath("proposal-reply-pending.png") });
    await proposedReply.hover();
    await proposedReply.getByRole("button", { name: "Approve" }).click();
    await expect.poll(readProposalIds).toEqual([]);
    expect((await readThreads(workspacePath)).threads[0]?.comments.map((comment) => comment.body)).toEqual([
      "Rename add to sum",
      "Renamed in the latest change",
    ]);
    await expect(proposedReply).not.toContainText("Pending approval");
    await window.screenshot({ path: testInfo.outputPath("proposal-reply-approved.png") });

    // Deleting a thread rejects the proposed replies to it, whose approve and reject actions were in the thread.
    await writePendingProposal(workspacePath, {
      version: 1,
      id: "orphaned-reply-proposal",
      threadId: "approved-proposal",
      comment: agentComment("orphaned-reply-proposal", "One more thing"),
    });
    await expect(approvedWidget.locator(".review-comment", { hasText: "One more thing" })).toBeVisible({ timeout: 30_000 });
    await approvedWidget.getByRole("button", { name: "Delete Thread" }).click();
    await expect.poll(readProposalIds).toEqual([]);
    expect((await readThreads(workspacePath)).threads).toEqual([]);
  } finally {
    await app.close();
  }
});

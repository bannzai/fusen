import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type FusenThread,
  deleteThread,
  parseThread,
  readThreads,
  threadFilePath,
  threadsDirectoryPath,
  writeThread,
} from "./threads.js";

/** Returns a valid thread with a human comment and an agent reply. */
function sampleThread(id: string): FusenThread {
  return {
    version: 1,
    id,
    file: "src/sample.ts",
    startLine: 2,
    endLine: 4,
    comments: [
      { id: "c1", body: "Rename this", author: "human", createdAt: "2026-09-25T00:00:00.000Z" },
      { id: "c2", body: "Done", author: "agent", createdAt: "2026-09-25T00:01:00.000Z" },
    ],
  };
}

/** Creates an empty directory that stands in for a workspace folder. */
async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "fusen-core-"));
}

test("readThreads returns no threads when .fusen/ does not exist", async () => {
  assert.deepEqual(await readThreads(await createWorkspace()), { threads: [], invalidFiles: [] });
});

test("writeThread stores one pretty-printed JSON file per thread that readThreads reads back", async () => {
  const workspaceRoot = await createWorkspace();
  await writeThread(workspaceRoot, sampleThread("thread-b"));
  await writeThread(workspaceRoot, sampleThread("thread-a"));

  assert.deepEqual(await readdir(threadsDirectoryPath(workspaceRoot)), ["thread-a.json", "thread-b.json"]);
  assert.equal(
    await readFile(path.join(workspaceRoot, ".fusen", "threads", "thread-a.json"), "utf8"),
    `${JSON.stringify(sampleThread("thread-a"), null, 2)}\n`,
  );
  assert.deepEqual(await readThreads(workspaceRoot), {
    threads: [sampleThread("thread-a"), sampleThread("thread-b")],
    invalidFiles: [],
  });
});

test("writeThread replaces the previous content and leaves no temporary file", async () => {
  const workspaceRoot = await createWorkspace();
  await writeThread(workspaceRoot, sampleThread("thread-a"));
  const editedThread = { ...sampleThread("thread-a"), comments: [sampleThread("thread-a").comments[0]!] };
  await writeThread(workspaceRoot, editedThread);
  await writeThread(workspaceRoot, editedThread);

  assert.deepEqual(await readdir(threadsDirectoryPath(workspaceRoot)), ["thread-a.json"]);
  assert.deepEqual((await readThreads(workspaceRoot)).threads, [editedThread]);
});

test("writeThread rejects an invalid thread without writing it", async () => {
  const workspaceRoot = await createWorkspace();
  await assert.rejects(writeThread(workspaceRoot, { ...sampleThread("thread-a"), comments: [] }));
  assert.deepEqual(await readThreads(workspaceRoot), { threads: [], invalidFiles: [] });
});

test("deleteThread removes the file and succeeds when the file is already gone", async () => {
  const workspaceRoot = await createWorkspace();
  await writeThread(workspaceRoot, sampleThread("thread-a"));
  await deleteThread(workspaceRoot, "thread-a");
  await deleteThread(workspaceRoot, "thread-a");

  assert.deepEqual(await readThreads(workspaceRoot), { threads: [], invalidFiles: [] });
});

test("readThreads reports broken files and still returns the valid threads", async () => {
  const workspaceRoot = await createWorkspace();
  await writeThread(workspaceRoot, sampleThread("thread-a"));
  const directoryPath = threadsDirectoryPath(workspaceRoot);
  await writeFile(path.join(directoryPath, "broken.json"), "{", "utf8");
  await writeFile(path.join(directoryPath, "renamed.json"), JSON.stringify(sampleThread("thread-b")), "utf8");
  await writeFile(path.join(directoryPath, "notes.txt"), "not a thread", "utf8");
  await mkdir(path.join(directoryPath, "nested"));

  const { threads, invalidFiles } = await readThreads(workspaceRoot);
  assert.deepEqual(threads, [sampleThread("thread-a")]);
  assert.deepEqual(
    invalidFiles.map((invalidFile) => path.basename(invalidFile.path)),
    ["broken.json", "renamed.json"],
  );
});

test("parseThread drops unknown fields", () => {
  assert.deepEqual(parseThread({ ...sampleThread("thread-a"), extra: true }), sampleThread("thread-a"));
});

test("parseThread keeps the code of the commented lines, which a thread may omit", () => {
  const thread = { ...sampleThread("thread-a"), code: ["  const a = 1;", "", "  return a;"] };
  assert.deepEqual(parseThread(thread), thread);
  assert.equal("code" in parseThread({ ...sampleThread("thread-a"), code: undefined }), false);
});

test("parseThread rejects values that are not a valid thread", () => {
  const thread = sampleThread("thread-a");
  const invalidValues: unknown[] = [
    null,
    [],
    { ...thread, version: 2 },
    { ...thread, id: "../escape" },
    { ...thread, file: "" },
    { ...thread, file: "/absolute/path.ts" },
    { ...thread, file: "C:/windows/path.ts" },
    { ...thread, file: "src\\sample.ts" },
    { ...thread, file: "../outside.ts" },
    { ...thread, file: "src//sample.ts" },
    { ...thread, startLine: 0 },
    { ...thread, startLine: 1.5 },
    { ...thread, startLine: 5, endLine: 4 },
    { ...thread, code: "  return a;" },
    { ...thread, code: ["one line for a range of three"] },
    { ...thread, code: ["a", "b\nc", "d"] },
    { ...thread, code: ["a", 2, "c"] },
    { ...thread, comments: [] },
    { ...thread, comments: [{ ...thread.comments[0], author: "bot" }] },
    { ...thread, comments: [{ ...thread.comments[0], body: 1 }] },
    { ...thread, comments: [{ ...thread.comments[0], createdAt: "yesterday" }] },
    { ...thread, comments: [{ ...thread.comments[0], id: "a/b" }] },
  ];
  for (const value of invalidValues) {
    assert.throws(() => parseThread(value), Error, JSON.stringify(value));
  }
});

test("threadFilePath rejects ids that could escape the threads directory", () => {
  assert.throws(() => threadFilePath("/workspace", "../thread"));
  assert.equal(threadFilePath("/workspace", "thread-a"), path.join("/workspace", ".fusen", "threads", "thread-a.json"));
});

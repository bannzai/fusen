import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type FusenComment,
  type FusenPendingProposal,
  type FusenPendingReply,
  type FusenThread,
  type LineRange,
  codeAt,
  createFusenId,
  createPrompt,
  deletePendingProposal,
  deleteThread,
  isPendingReply,
  isProposalInThreads,
  locateCode,
  moveLineRange,
  pendingDirectoryPath,
  pendingProposalFilePath,
  promptFilePath,
  readGitState,
  readPendingProposals,
  readThread,
  readThreads,
  threadFilePath,
  writePrompt,
  writeThread,
} from "fusen-core";
import * as vscode from "vscode";

/** A comment shown in the editor, with the ids that locate the stored comment it shows. */
interface FusenEditorComment extends vscode.Comment {
  /** The editor thread that shows this comment. */
  commentThread: vscode.CommentThread;
  /** Id of the stored comment in the thread's `.fusen/threads/<id>.json`. */
  fusenCommentId: string;
}

/** A comment shown in the editor for an agent's pending proposal, which the approve and reject actions act on. */
interface FusenProposalEditorComment extends vscode.Comment {
  /** Path of the proposal's file in `.fusen/_pending/`, the key of `storedProposals`. */
  fusenProposalFilePath: string;
}

/**
 * A thread as stored in `.fusen/`, with the workspace folder whose `.fusen/` holds it.
 * The folder is kept rather than looked up from the file, because with nested workspace folders
 * the innermost folder containing the file is not necessarily the one the thread was read from.
 */
interface StoredThread {
  /** File system path of the workspace folder that stores the thread. */
  workspaceRoot: string;
  /** The stored thread, whose `file` is relative to `workspaceRoot`. */
  fusenThread: FusenThread;
}

/** A proposal as stored in `.fusen/_pending/`, with the workspace folder whose `.fusen/` holds it. */
interface StoredProposal {
  /** File system path of the workspace folder that stores the proposal. */
  workspaceRoot: string;
  /** The stored proposal. */
  proposal: FusenPendingProposal;
}

// `contextValue` of a pending proposal's editor thread and of a pending reply's comment; the approve and reject
// menus in package.json match it. The comments of a proposed thread use a separate value so that neither those
// menus nor the edit and delete menus of stored comments apply to them.
const proposalContextValue = "proposal";
const proposedThreadCommentContextValue = "proposedThreadComment";
// Shown in the header of a proposed thread and next to the author of a proposed reply, so they read as waiting for approval.
const pendingLabel = "Pending approval";

export function activate(context: vscode.ExtensionContext): void {
  // Visible marker that the extension host activated Fusen; the E2E test asserts on it.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.name = "Fusen";
  statusBarItem.text = "$(note) Fusen";
  statusBarItem.show();

  const commentController = vscode.comments.createCommentController("fusen", "Fusen");
  commentController.options = { prompt: "Add a Fusen note", placeHolder: "Write a note in markdown" };
  commentController.commentingRangeProvider = {
    // Every line of a file inside a workspace folder can be commented, whether or not git tracks it.
    // Files outside the workspace folders have no `.fusen/` to store the thread in.
    provideCommentingRanges: (document) =>
      document.uri.scheme === "file" && vscode.workspace.getWorkspaceFolder(document.uri)
        ? [new vscode.Range(0, 0, document.lineCount - 1, 0)]
        : [],
  };

  // The stored thread behind each editor thread. The editor thread is always rendered from it,
  // and every change is written to `.fusen/` before it is rendered.
  const storedThreads = new Map<vscode.CommentThread, StoredThread>();
  // The last change queued for each editor thread; see `changeThread`.
  const threadChanges = new WeakMap<vscode.CommentThread, Promise<void>>();
  // The pending proposals of every workspace folder, keyed by the path of their file in `.fusen/_pending/`,
  // as last read from disk. A proposed thread is shown as its own editor thread, and a proposed reply
  // is shown at the end of the editor thread of the thread it replies to.
  const storedProposals = new Map<string, StoredProposal>();
  // The editor thread of each proposed thread, keyed like `storedProposals`.
  const proposalThreads = new Map<string, vscode.CommentThread>();
  // The file watcher of `.fusen/` of each loaded workspace folder, keyed by the folder's path.
  const proposalWatchers = new Map<string, vscode.FileSystemWatcher>();
  // The modification time of `.fusen/_pending/` last seen for each workspace folder, or `null` while it does not exist;
  // see `reloadProposalsIfPendingDirectoryChanged`.
  const pendingDirectoryModifiedTimes = new Map<string, number | null>();
  // Problems already reported, so that re-reading `.fusen/_pending/` on every change does not repeat them.
  const reportedProblems = new Set<string>();
  // The last change queued to the proposals; see `changeProposals`.
  let proposalChanges = Promise.resolve();
  // Threads whose code is not in their file any more. They are shown as "location unknown", are not moved by edits,
  // and keep the lines and code stored in `.fusen/`, so that they are placed again if the code comes back.
  const unlocatedThreads = new WeakSet<vscode.CommentThread>();
  // The code on the lines of each thread as the editor last showed it, including unsaved edits. When an edit deletes
  // the code, this is what an undo brings back, so an unsaved document is searched for it rather than for the stored code.
  // It also stands in for the stored code of a thread started on unsaved changes, which has none until the document is saved.
  const editorCodes = new WeakMap<vscode.CommentThread, string[]>();
  // Whether editors are already due to read their comments again; see `refreshEditorComments`.
  let editorCommentsRefreshQueued = false;

  /**
   * Makes every editor read its comment threads again, once for all the threads created in the same turn of the event loop.
   * An editor reads the threads of its file whenever a comment controller is registered or changed, or a file is opened,
   * and VS Code (checked in 1.139.0) can drop a thread created while two of those reads are in flight: when the earlier read
   * finishes, the editor forgets that the later one is still running, so it shows the new thread right away, and then the
   * later read, which listed the threads before the new one existed, replaces every thread widget in the editor with the ones
   * it listed. Nothing reads again afterwards, so a note restored at startup or a proposal that arrives then stays hidden
   * until its file is opened again. See "Showing threads in the editor" in documents/PROJECT.md.
   */
  function refreshEditorComments(): void {
    if (editorCommentsRefreshQueued) {
      return;
    }
    editorCommentsRefreshQueued = true;
    setImmediate(() => {
      editorCommentsRefreshQueued = false;
      // Assigning the provider, even the same one, makes every editor read its threads again. The request reaches VS Code
      // after the threads created before it, so that read lists them, and it finishes after the reads started earlier.
      commentController.commentingRangeProvider = commentController.commentingRangeProvider;
    });
  }

  /** Returns the stored thread behind `commentThread`. Throws for a thread that has not been saved yet. */
  function storedThread(commentThread: vscode.CommentThread): StoredThread {
    const stored = storedThreads.get(commentThread);
    if (!stored) {
      throw new Error("This thread is not stored by Fusen");
    }
    return stored;
  }

  /**
   * Runs `change` after the changes already queued for `commentThread`, so that each change reads the thread
   * the previous one saved instead of overwriting it with an older copy.
   */
  function changeThread(commentThread: vscode.CommentThread, change: () => Promise<void>): Promise<void> {
    const queuedChange = (threadChanges.get(commentThread) ?? Promise.resolve())
      // A failed change was already reported by the command that queued it; the next change still runs.
      .catch(() => undefined)
      .then(change);
    threadChanges.set(commentThread, queuedChange);
    return queuedChange;
  }

  /**
   * Runs `change` after the changes already queued to the proposals, so that a re-read of `.fusen/_pending/`
   * never interleaves with an approval or a rejection and shows a proposal that was just decided.
   */
  function changeProposals(change: () => Promise<void>): Promise<void> {
    proposalChanges = proposalChanges.catch(() => undefined).then(change);
    return proposalChanges;
  }

  /** Shows `message` as a warning unless it was already shown. */
  function reportProblemOnce(message: string): void {
    if (!reportedProblems.has(message)) {
      reportedProblems.add(message);
      void vscode.window.showWarningMessage(message);
    }
  }

  /** Returns the pending replies to the stored thread `stored` whose comment is not in the thread yet. */
  function pendingReplies(stored: StoredThread): [string, FusenPendingReply][] {
    const storedCommentIds = new Set(stored.fusenThread.comments.map((fusenComment) => fusenComment.id));
    return [...storedProposals].flatMap(([proposalFilePath, { workspaceRoot, proposal }]): [string, FusenPendingReply][] =>
      workspaceRoot === stored.workspaceRoot &&
      isPendingReply(proposal) &&
      proposal.threadId === stored.fusenThread.id &&
      // A just approved reply is already in the thread until `.fusen/_pending/` is read again.
      !storedCommentIds.has(proposal.comment.id)
        ? [[proposalFilePath, proposal]]
        : [],
    );
  }

  /**
   * Shows the comments of the stored thread in `commentThread`, followed by the pending replies to it.
   * Comments keep their objects across renders, because VS Code keeps the widget of the same object,
   * including the unsaved text of a comment being edited, and recreates the widget of a new one.
   * A comment not being edited gets a new object when its author name changed; see `reusableComment`.
   */
  function render(commentThread: vscode.CommentThread): void {
    commentThread.label = unlocatedThreads.has(commentThread) ? "Location unknown: the noted code is not in the file" : undefined;
    const renderedComments = new Map(
      commentThread.comments.flatMap((comment) =>
        "fusenCommentId" in comment ? [[(comment as FusenEditorComment).fusenCommentId, comment as FusenEditorComment] as const] : [],
      ),
    );
    const renderedReplies = new Map(
      commentThread.comments.flatMap((comment) =>
        "fusenProposalFilePath" in comment
          ? [[(comment as FusenProposalEditorComment).fusenProposalFilePath, comment as FusenProposalEditorComment] as const]
          : [],
      ),
    );
    const stored = storedThread(commentThread);
    commentThread.comments = [
      ...stored.fusenThread.comments.map((fusenComment) => {
        const renderedComment = renderedComments.get(fusenComment.id);
        if (renderedComment?.mode === vscode.CommentMode.Editing) {
          return renderedComment;
        }
        const view = commentView(fusenComment);
        return Object.assign(reusableComment(renderedComment, view) ?? { commentThread, fusenCommentId: fusenComment.id }, view);
      }),
      ...pendingReplies(stored).map(([proposalFilePath, reply]) => {
        const view = commentView(reply.comment);
        return Object.assign(reusableComment(renderedReplies.get(proposalFilePath), view) ?? { fusenProposalFilePath: proposalFilePath }, view, {
          label: pendingLabel,
          contextValue: proposalContextValue,
        });
      }),
    ];
  }

  /** Writes the thread to `.fusen/` of its workspace folder and shows it in `commentThread`. */
  async function save(commentThread: vscode.CommentThread, stored: StoredThread): Promise<void> {
    await writeThread(stored.workspaceRoot, stored.fusenThread);
    storedThreads.set(commentThread, stored);
    render(commentThread);
  }

  /**
   * Deletes the stored file of `commentThread`, if any, and removes the thread from the editor.
   * Re-reading the proposals afterwards rejects the pending replies to the thread; see `reloadProposals`.
   */
  async function remove(commentThread: vscode.CommentThread): Promise<void> {
    const stored = storedThreads.get(commentThread);
    if (stored) {
      await deleteThread(stored.workspaceRoot, stored.fusenThread.id);
      // Not awaited: an approval holds the proposal queue while it waits for this thread's queue.
      changeProposals(() => reloadProposals(stored.workspaceRoot)).catch(reportError("could not read proposals"));
    }
    storedThreads.delete(commentThread);
    commentThread.dispose();
  }

  /** Creates an expanded editor thread on the lines of `fusenThread` in the workspace folder at `workspaceRoot`. */
  function createEditorThread(workspaceRoot: string, fusenThread: FusenThread): vscode.CommentThread {
    const commentThread = commentController.createCommentThread(
      vscode.Uri.joinPath(
        // The folder's own URI makes the thread's URI equal to its document's, which `storedThreadsOn` compares as strings.
        vscode.workspace.workspaceFolders?.find((workspaceFolder) => workspaceFolder.uri.fsPath === workspaceRoot)?.uri ??
          vscode.Uri.file(workspaceRoot),
        fusenThread.file,
      ),
      editorRange(fusenThread),
      [],
    );
    commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    refreshEditorComments();
    return commentThread;
  }

  /** Shows the stored thread `stored` in a new editor thread and returns it. */
  function showStoredThread(stored: StoredThread): vscode.CommentThread {
    const commentThread = createEditorThread(stored.workspaceRoot, stored.fusenThread);
    storedThreads.set(commentThread, stored);
    render(commentThread);
    return commentThread;
  }

  /**
   * Writes `lineRange` of `fileText`, the text of the file on disk, and the code on those lines to `.fusen/` if they changed.
   * The range shown in the editor is left as it is, because edits made after `fileText` was read have already moved it.
   * Only the location is written over the thread file as it is now, because the file may have changed outside the editor,
   * for example by a git checkout that also moved the code; a thread file that is gone is not written again.
   */
  async function writeLocation(commentThread: vscode.CommentThread, lineRange: LineRange, fileText: string): Promise<void> {
    const stored = storedThreads.get(commentThread);
    const code = codeAt(fileText, lineRange);
    // The thread was deleted while this change waited in the queue, or the lines are not in the file.
    if (!stored || !code) {
      return;
    }
    const fusenThread = await readThread(stored.workspaceRoot, stored.fusenThread.id);
    if (!fusenThread) {
      return;
    }
    if (
      lineRange.startLine !== fusenThread.startLine ||
      lineRange.endLine !== fusenThread.endLine ||
      code.join("\n") !== fusenThread.code?.join("\n")
    ) {
      await save(commentThread, { ...stored, fusenThread: { ...fusenThread, ...lineRange, code } });
    } else {
      storedThreads.set(commentThread, { ...stored, fusenThread });
      render(commentThread);
    }
  }

  /**
   * Finds the code of `commentThread` in `fileText`, the current text of its file, and shows the thread there.
   * The code searched for is `code` if given, else the stored code, else the code the editor last showed on the thread.
   * Only a thread that has neither, such as one written by an agent, takes the code at its stored lines.
   * The thread is shown as location unknown when the code is not in the file or the file (`fileText` undefined) is gone.
   *
   * When `fileText` is also the text on disk (`saved`), writing the lines and their code to `.fusen/` is queued.
   * Unsaved text is not written, because the stored line numbers must refer to the file that the MCP server and agents read.
   * The thread is shown synchronously, so that an edit reported after `fileText` was read moves it from the new place.
   */
  function relocate(commentThread: vscode.CommentThread, fileText: string | undefined, saved: boolean, code?: readonly string[]): void {
    const stored = storedThreads.get(commentThread);
    if (!stored) {
      return;
    }
    const { fusenThread } = stored;
    const threadCode =
      fileText === undefined ? undefined : (code ?? fusenThread.code ?? editorCodes.get(commentThread) ?? codeAt(fileText, fusenThread));
    const lineRange = fileText !== undefined && threadCode ? locateCode(fileText, threadCode, fusenThread.startLine) : undefined;
    if (fileText === undefined || !lineRange) {
      unlocatedThreads.add(commentThread);
      render(commentThread);
      return;
    }
    unlocatedThreads.delete(commentThread);
    commentThread.range = editorRange(lineRange);
    const placedCode = codeAt(fileText, lineRange);
    if (placedCode) {
      editorCodes.set(commentThread, placedCode);
    }
    render(commentThread);
    if (saved) {
      changeThreadReportingErrors(commentThread, () => writeLocation(commentThread, lineRange, fileText));
    }
  }

  /** Queues `change` for `commentThread` like `changeThread`, reporting a failure, for changes that no command awaits. */
  function changeThreadReportingErrors(commentThread: vscode.CommentThread, change: () => Promise<void>): void {
    changeThread(commentThread, change).catch((error: unknown) => {
      void vscode.window.showErrorMessage(`Fusen could not update a note: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Returns the editor threads that are stored by Fusen and are on the file `uri`. */
  function storedThreadsOn(uri: vscode.Uri): vscode.CommentThread[] {
    return [...storedThreads.keys()].filter((commentThread) => commentThread.uri.toString() === uri.toString());
  }

  /**
   * Returns the current text of the file `uri` and whether it is the text on disk.
   * An open document is read rather than the disk, because it may have unsaved changes that the thread is shown on.
   * The text is `undefined` when the file does not exist.
   */
  async function readFileText(uri: vscode.Uri): Promise<{ text: string | undefined; saved: boolean }> {
    const document = vscode.workspace.textDocuments.find((textDocument) => textDocument.uri.toString() === uri.toString());
    if (document) {
      return { text: document.getText(), saved: !document.isDirty };
    }
    try {
      // Decoded like the editor would, with the encoding settings of the file, so that the text matches the document's.
      return { text: await vscode.workspace.decode(await vscode.workspace.fs.readFile(uri), { uri }), saved: true };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return { text: undefined, saved: true };
      }
      throw error;
    }
  }

  /** Places every stored thread on the file `uri` where its code is now in the file. */
  async function relocateThreadsOn(uri: vscode.Uri): Promise<void> {
    const commentThreads = storedThreadsOn(uri);
    if (commentThreads.length === 0) {
      return;
    }
    const { text, saved } = await readFileText(uri);
    for (const commentThread of commentThreads) {
      relocate(commentThread, text, saved);
    }
  }

  /** Relocates the threads on the file `uri`, reporting a failure instead of rejecting. */
  function relocateThreadsOnReportingErrors(uri: vscode.Uri): void {
    relocateThreadsOn(uri).catch((error: unknown) => {
      void vscode.window.showErrorMessage(`Fusen could not update notes: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Shows every thread stored under `.fusen/` of `workspaceFolders`, as it was when the workspace was last open. */
  async function restoreThreads(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    for (const workspaceFolder of workspaceFolders) {
      const { threads, invalidFiles } = await readThreads(workspaceFolder.uri.fsPath);
      for (const invalidFile of invalidFiles) {
        void vscode.window.showWarningMessage(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
      }
      const fileUris = new Map<string, vscode.Uri>();
      for (const fusenThread of threads) {
        const commentThread = showStoredThread({ workspaceRoot: workspaceFolder.uri.fsPath, fusenThread });
        fileUris.set(commentThread.uri.toString(), commentThread.uri);
      }
      // The files may have changed while the workspace was closed, for example by a git checkout.
      for (const fileUri of fileUris.values()) {
        await relocateThreadsOn(fileUri);
      }
    }
  }

  /** Shows the comments of the proposed thread `proposal`, stored in `proposalFilePath`, in its editor thread `commentThread`. */
  function renderProposalThread(commentThread: vscode.CommentThread, proposalFilePath: string, proposal: FusenThread): void {
    commentThread.comments = proposal.comments.map((fusenComment): FusenProposalEditorComment => ({
      fusenProposalFilePath: proposalFilePath,
      ...commentView(fusenComment),
      contextValue: proposedThreadCommentContextValue,
    }));
  }

  /** Removes the editor thread of the proposed thread in `proposalFilePath`, if it is shown. */
  function removeProposalThread(proposalFilePath: string): void {
    proposalThreads.get(proposalFilePath)?.dispose();
    proposalThreads.delete(proposalFilePath);
  }

  /**
   * Makes the editor show the proposals in `.fusen/_pending/` of the workspace folder at `workspaceRoot` as they are on disk:
   * proposed threads as editor threads with approve and reject actions, and proposed replies in the threads they reply to.
   * Running it again without a change on disk changes nothing.
   */
  async function reloadProposals(workspaceRoot: string): Promise<void> {
    const { proposals: proposalsInDirectory, invalidFiles } = await readPendingProposals(workspaceRoot);
    for (const invalidFile of invalidFiles) {
      reportProblemOnce(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
    }
    // A proposal already in a thread is left over from an approval that stopped between saving the thread and deleting
    // the proposal, and a reply to a thread that no longer exists has no thread to show its approve and reject actions in.
    // Both are settled here, as approved and as rejected; otherwise they would stay pending with no action left to decide them.
    // A thread file that exists but cannot be read is not a deleted thread, so replies to it are kept.
    const { threads, invalidFiles: invalidThreadFiles } = await readThreads(workspaceRoot);
    const invalidThreadFilePaths = new Set(invalidThreadFiles.map((invalidFile) => invalidFile.path));
    const proposals: FusenPendingProposal[] = [];
    for (const proposal of proposalsInDirectory) {
      if (
        !isProposalInThreads(threads, proposal.id) &&
        !(
          isPendingReply(proposal) &&
          !threads.some((thread) => thread.id === proposal.threadId) &&
          !invalidThreadFilePaths.has(threadFilePath(workspaceRoot, proposal.threadId))
        )
      ) {
        proposals.push(proposal);
        continue;
      }
      await deletePendingProposal(workspaceRoot, proposal.id);
      const approvedThread = threads.find((thread) => thread.id === proposal.id);
      if (
        approvedThread &&
        ![...storedThreads.values()].some((stored) => stored.workspaceRoot === workspaceRoot && stored.fusenThread.id === approvedThread.id)
      ) {
        relocateThreadsOnReportingErrors(showStoredThread({ workspaceRoot, fusenThread: approvedThread }).uri);
      }
    }
    const proposalsOnDisk = new Map(proposals.map((proposal) => [pendingProposalFilePath(workspaceRoot, proposal.id), proposal]));
    for (const [proposalFilePath, stored] of storedProposals) {
      if (stored.workspaceRoot === workspaceRoot && !proposalsOnDisk.has(proposalFilePath)) {
        storedProposals.delete(proposalFilePath);
        removeProposalThread(proposalFilePath);
      }
    }
    for (const [proposalFilePath, proposal] of proposalsOnDisk) {
      if (JSON.stringify(storedProposals.get(proposalFilePath)?.proposal) === JSON.stringify(proposal)) {
        continue;
      }
      storedProposals.set(proposalFilePath, { workspaceRoot, proposal });
      removeProposalThread(proposalFilePath);
      if (!isPendingReply(proposal)) {
        const commentThread = createEditorThread(workspaceRoot, proposal);
        commentThread.label = pendingLabel;
        commentThread.contextValue = proposalContextValue;
        commentThread.canReply = false;
        renderProposalThread(commentThread, proposalFilePath, proposal);
        proposalThreads.set(proposalFilePath, commentThread);
      }
    }
    const storedThreadsOfFolder = [...storedThreads].filter(([, stored]) => stored.workspaceRoot === workspaceRoot);
    for (const [commentThread] of storedThreadsOfFolder) {
      render(commentThread);
    }
    for (const proposal of proposals) {
      if (!isPendingReply(proposal) || storedThreadsOfFolder.some(([, stored]) => stored.fusenThread.id === proposal.threadId)) {
        continue;
      }
      // A thread written after the workspace was restored, for example by a git checkout, is shown so that the reply to it can be decided.
      const repliedThread = threads.find((thread) => thread.id === proposal.threadId);
      if (!repliedThread) {
        reportProblemOnce(`Fusen cannot show the reply ${proposal.id} because the thread ${proposal.threadId} cannot be read`);
      } else if (![...storedThreads.values()].some((stored) => stored.workspaceRoot === workspaceRoot && stored.fusenThread.id === repliedThread.id)) {
        relocateThreadsOnReportingErrors(showStoredThread({ workspaceRoot, fusenThread: repliedThread }).uri);
      }
    }
  }

  /** Returns the path of the proposal file that the approve or reject action on `target` acts on. */
  function proposalFilePathOf(target: vscode.CommentThread | FusenProposalEditorComment): string {
    if ("fusenProposalFilePath" in target) {
      return target.fusenProposalFilePath;
    }
    const proposalFilePath = [...proposalThreads].find(([, commentThread]) => commentThread === target)?.[0];
    if (!proposalFilePath) {
      throw new Error("This thread is not a pending proposal");
    }
    return proposalFilePath;
  }

  /** Returns the pending proposal that the approve or reject action on `target` acts on. */
  function storedProposal(target: vscode.CommentThread | FusenProposalEditorComment): StoredProposal {
    const stored = storedProposals.get(proposalFilePathOf(target));
    if (!stored) {
      throw new Error("This proposal is no longer pending");
    }
    return stored;
  }

  /**
   * Re-reads `.fusen/_pending/` of the workspace folder at `workspaceRoot` when the directory's modification time
   * differs from the last one seen. Creating, renaming into place or deleting a proposal file changes it.
   */
  async function reloadProposalsIfPendingDirectoryChanged(workspaceRoot: string): Promise<void> {
    const modifiedTime = await stat(pendingDirectoryPath(workspaceRoot)).then(
      (stats) => stats.mtimeMs,
      // A directory that cannot be read has no proposals to show, the same as one that does not exist.
      () => null,
    );
    if (pendingDirectoryModifiedTimes.get(workspaceRoot) === modifiedTime) {
      return;
    }
    pendingDirectoryModifiedTimes.set(workspaceRoot, modifiedTime);
    await changeProposals(() => reloadProposals(workspaceRoot));
  }

  /** Watches `.fusen/` of `workspaceFolders` and shows the proposals already in `.fusen/_pending/`, after their threads. */
  function loadWorkspaceFolders(workspaceFolders: readonly vscode.WorkspaceFolder[]): void {
    for (const workspaceFolder of workspaceFolders) {
      const workspaceRoot = workspaceFolder.uri.fsPath;
      // The whole `.fusen/` is watched, because the events of files written into a directory created in the same instant,
      // as the first proposal creates `.fusen/_pending/`, can be missed while the creation of the directories is reported.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, ".fusen/**"));
      const reload = () => {
        changeProposals(() => reloadProposals(workspaceRoot)).catch(reportError("could not read proposals"));
      };
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      proposalWatchers.set(workspaceRoot, watcher);
    }
    // Proposed replies are shown in their threads, so the threads are restored first.
    changeProposals(async () => {
      await restoreThreads(workspaceFolders);
      for (const workspaceFolder of workspaceFolders) {
        await reloadProposals(workspaceFolder.uri.fsPath);
      }
    }).catch(reportError("could not restore notes"));
  }

  // VS Code's file watcher can miss changes, for example ones made shortly after startup, so the modification time
  // of `.fusen/_pending/` is also checked on an interval. Two seconds keeps a missed proposal from waiting long
  // enough for a person to notice, for the cost of one stat call per workspace folder.
  const pendingDirectoryCheck = setInterval(() => {
    for (const workspaceRoot of proposalWatchers.keys()) {
      reloadProposalsIfPendingDirectoryChanged(workspaceRoot).catch(reportError("could not read proposals"));
    }
  }, 2_000);

  // Changes outside the editor, such as a git checkout or an agent rewriting a file, reach files that are not open only through the file system.
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher("**/*");

  context.subscriptions.push(
    statusBarItem,
    commentController,
    { dispose: () => proposalWatchers.forEach((watcher) => watcher.dispose()) },
    { dispose: () => clearInterval(pendingDirectoryCheck) },
    vscode.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
      // A thread or proposal whose folder left the workspace has no `.fusen/` to save to any more.
      const removedWorkspaceRoots = new Set(removed.map((workspaceFolder) => workspaceFolder.uri.fsPath));
      for (const [commentThread, stored] of storedThreads) {
        if (removedWorkspaceRoots.has(stored.workspaceRoot)) {
          storedThreads.delete(commentThread);
          commentThread.dispose();
        }
      }
      for (const [proposalFilePath, stored] of storedProposals) {
        if (removedWorkspaceRoots.has(stored.workspaceRoot)) {
          storedProposals.delete(proposalFilePath);
          removeProposalThread(proposalFilePath);
        }
      }
      for (const workspaceRoot of removedWorkspaceRoots) {
        proposalWatchers.get(workspaceRoot)?.dispose();
        proposalWatchers.delete(workspaceRoot);
        pendingDirectoryModifiedTimes.delete(workspaceRoot);
      }
      loadWorkspaceFolders(added);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      // An event without content changes only reports that the document became dirty or clean.
      if (contentChanges.length === 0) {
        return;
      }
      if (!document.isDirty) {
        // The document matches the file on disk again: VS Code reloaded it after a change outside the editor,
        // or the edits were undone. The stored code, written for the file on disk, tells where each thread is.
        const text = document.getText();
        for (const commentThread of storedThreadsOn(document.uri)) {
          relocate(commentThread, text, true);
        }
        return;
      }
      for (const commentThread of storedThreadsOn(document.uri)) {
        if (unlocatedThreads.has(commentThread)) {
          // The edit may have brought the code back, for example by undoing its deletion. The document is not saved,
          // so the thread is only shown there until the save writes it.
          relocate(commentThread, document.getText(), false, editorCodes.get(commentThread));
          continue;
        }
        if (!commentThread.range) {
          continue;
        }
        const lineRange = moveLineRange(editorLineRange(commentThread.range), contentChanges, (lineIndex) => document.lineAt(lineIndex).text);
        if (lineRange) {
          commentThread.range = editorRange(lineRange);
          // Clamped so that a line past the end of the document, which moveLineRange does not return, cannot throw here.
          editorCodes.set(
            commentThread,
            Array.from({ length: lineRange.endLine - lineRange.startLine + 1 }, (_, offset) =>
              document.lineAt(Math.min(lineRange.startLine - 1 + offset, document.lineCount - 1)).text,
            ),
          );
        } else {
          unlocatedThreads.add(commentThread);
          render(commentThread);
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      // Read at the time of the save, because the document can be edited again before the queued change runs.
      const text = document.getText();
      for (const commentThread of storedThreadsOn(document.uri)) {
        const range = commentThread.range;
        if (unlocatedThreads.has(commentThread) || !range) {
          relocate(commentThread, text, true);
        } else {
          changeThreadReportingErrors(commentThread, () => writeLocation(commentThread, editorLineRange(range), text));
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      // Edits discarded when the document was closed without saving may have moved its threads.
      relocateThreadsOnReportingErrors(document.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // The author names come from the settings, so the open threads are shown again with the new names.
      if (!event.affectsConfiguration("fusen.humanName") && !event.affectsConfiguration("fusen.agentName")) {
        return;
      }
      for (const commentThread of storedThreads.keys()) {
        render(commentThread);
      }
      for (const [proposalFilePath, commentThread] of proposalThreads) {
        const proposal = storedProposals.get(proposalFilePath)?.proposal;
        if (proposal && !isPendingReply(proposal)) {
          renderProposalThread(commentThread, proposalFilePath, proposal);
        }
      }
    }),
    fileSystemWatcher,
    fileSystemWatcher.onDidCreate((uri) => relocateThreadsOnReportingErrors(uri)),
    fileSystemWatcher.onDidChange((uri) => {
      // An open document follows its file through the document events above: VS Code reloads it when the file changes on disk.
      if (vscode.workspace.textDocuments.some((textDocument) => textDocument.uri.toString() === uri.toString())) {
        return;
      }
      relocateThreadsOnReportingErrors(uri);
    }),
    fileSystemWatcher.onDidDelete((uri) => {
      // An open document keeps its text after the file is deleted, so the file is gone even if the document still has the code.
      for (const commentThread of storedThreadsOn(uri)) {
        relocate(commentThread, undefined, true);
      }
    }),
    vscode.commands.registerCommand("fusen.createThread", (reply: vscode.CommentReply) =>
      changeThread(reply.thread, async () => {
        const commentThread = reply.thread;
        // provideCommentingRanges offers line ranges only, so a thread started from the gutter always has one.
        if (!commentThread.range) {
          throw new Error("Fusen notes need a line range");
        }
        // provideCommentingRanges offers files inside a workspace folder only, so the folder exists.
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(commentThread.uri);
        if (!workspaceFolder) {
          throw new Error(`${commentThread.uri.fsPath} is not inside a workspace folder`);
        }
        commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        const lineRange = editorLineRange(commentThread.range);
        // `openTextDocument` returns the document the note was started in, which is open in the editor.
        const document = await vscode.workspace.openTextDocument(commentThread.uri);
        const code = codeAt(document.getText(), lineRange);
        if (code) {
          editorCodes.set(commentThread, code);
        }
        const file = path.relative(workspaceFolder.uri.fsPath, commentThread.uri.fsPath).split(path.sep).join("/");
        await save(commentThread, {
          workspaceRoot: workspaceFolder.uri.fsPath,
          fusenThread: {
            version: 1,
            id: createFusenId(),
            file,
            ...lineRange,
            // Unsaved code is not in the file on disk, so it is left out until saving the document writes the code of the lines.
            code: document.isDirty ? undefined : code,
            comments: [await humanComment(workspaceFolder.uri.fsPath, file, reply.text)],
          },
        });
      }),
    ),
    vscode.commands.registerCommand("fusen.reply", (reply: vscode.CommentReply) =>
      changeThread(reply.thread, async () => {
        const { workspaceRoot, fusenThread } = storedThread(reply.thread);
        await save(reply.thread, {
          workspaceRoot,
          fusenThread: {
            ...fusenThread,
            comments: [...fusenThread.comments, await humanComment(workspaceRoot, fusenThread.file, reply.text)],
          },
        });
      }),
    ),
    vscode.commands.registerCommand("fusen.editComment", (comment: FusenEditorComment) => {
      const fusenComment = storedThread(comment.commentThread).fusenThread.comments.find(
        (storedComment) => storedComment.id === comment.fusenCommentId,
      );
      if (!fusenComment) {
        throw new Error("This comment is not stored by Fusen");
      }
      // The editor shows the markdown source rather than the rendered preview.
      comment.body = fusenComment.body;
      comment.mode = vscode.CommentMode.Editing;
      render(comment.commentThread);
    }),
    vscode.commands.registerCommand("fusen.cancelEditComment", (comment: FusenEditorComment) => {
      comment.mode = vscode.CommentMode.Preview;
      render(comment.commentThread);
    }),
    vscode.commands.registerCommand("fusen.saveComment", (comment: FusenEditorComment) => {
      // VS Code puts the edited text into `comment.body` before it runs this command.
      const body = typeof comment.body === "string" ? comment.body : comment.body.value;
      comment.mode = vscode.CommentMode.Preview;
      return changeThread(comment.commentThread, async () => {
        const { workspaceRoot, fusenThread } = storedThread(comment.commentThread);
        await save(comment.commentThread, {
          workspaceRoot,
          fusenThread: {
            ...fusenThread,
            comments: fusenThread.comments.map((fusenComment) =>
              fusenComment.id === comment.fusenCommentId ? { ...fusenComment, body } : fusenComment,
            ),
          },
        });
      });
    }),
    vscode.commands.registerCommand("fusen.deleteComment", (comment: FusenEditorComment) =>
      changeThread(comment.commentThread, async () => {
        const { workspaceRoot, fusenThread } = storedThread(comment.commentThread);
        const comments = fusenThread.comments.filter((fusenComment) => fusenComment.id !== comment.fusenCommentId);
        // A stored thread always has a comment, so deleting the last one deletes the thread.
        if (comments.length === 0) {
          await remove(comment.commentThread);
        } else {
          await save(comment.commentThread, { workspaceRoot, fusenThread: { ...fusenThread, comments } });
        }
      }),
    ),
    vscode.commands.registerCommand("fusen.deleteThread", (commentThread: vscode.CommentThread) =>
      changeThread(commentThread, () => remove(commentThread)),
    ),
    vscode.commands.registerCommand("fusen.approveProposal", (target: vscode.CommentThread | FusenProposalEditorComment) =>
      changeProposals(async () => {
        const { workspaceRoot, proposal } = storedProposal(target);
        if (isPendingReply(proposal)) {
          const repliedThread = [...storedThreads].find(
            ([, stored]) => stored.workspaceRoot === workspaceRoot && stored.fusenThread.id === proposal.threadId,
          )?.[0];
          if (!repliedThread) {
            throw new Error(`The thread ${proposal.threadId} of this reply does not exist`);
          }
          await changeThread(repliedThread, async () => {
            // Read from disk, because the thread file may have changed outside the editor since the thread was shown.
            const fusenThread = await readThread(workspaceRoot, proposal.threadId);
            if (!fusenThread) {
              throw new Error(`The thread ${proposal.threadId} of this reply does not exist`);
            }
            await save(repliedThread, { workspaceRoot, fusenThread: { ...fusenThread, comments: [...fusenThread.comments, proposal.comment] } });
          });
          await deletePendingProposal(workspaceRoot, proposal.id);
          await reloadProposals(workspaceRoot);
        } else {
          await writeThread(workspaceRoot, proposal);
          await deletePendingProposal(workspaceRoot, proposal.id);
          // The proposal's editor thread goes away before the approved thread appears, so the two are never shown together.
          await reloadProposals(workspaceRoot);
          // Placing it on its `code` follows lines that moved while the proposal waited; one without `code` takes the code at its lines.
          relocateThreadsOnReportingErrors(showStoredThread({ workspaceRoot, fusenThread: proposal }).uri);
        }
      }),
    ),
    vscode.commands.registerCommand("fusen.rejectProposal", (target: vscode.CommentThread | FusenProposalEditorComment) =>
      changeProposals(async () => {
        // Rejecting keeps no record; see "Storage format" in documents/PROJECT.md.
        const { workspaceRoot, proposal } = storedProposal(target);
        await deletePendingProposal(workspaceRoot, proposal.id);
        await reloadProposals(workspaceRoot);
      }),
    ),
    vscode.commands.registerCommand("fusen.copyPrompt", async () => {
      const picked = await pickPromptThreads();
      if (!picked) {
        return;
      }
      await vscode.env.clipboard.writeText(await createPrompt(picked.workspaceRoot, picked.threads));
      void vscode.window.showInformationMessage(
        `Fusen copied ${picked.threads.length} ${picked.threads.length === 1 ? "thread" : "threads"} as a prompt`,
      );
    }),
    vscode.commands.registerCommand("fusen.exportPrompt", async () => {
      const picked = await pickPromptThreads();
      if (!picked) {
        return;
      }
      await writePrompt(picked.workspaceRoot, await createPrompt(picked.workspaceRoot, picked.threads));
      await vscode.window.showTextDocument(vscode.Uri.file(promptFilePath(picked.workspaceRoot)));
    }),
  );

  loadWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
}

export function deactivate(): void {}

/** Returns the editor range that shows a thread on `lineRange`. */
function editorRange(lineRange: LineRange): vscode.Range {
  return new vscode.Range(lineRange.startLine - 1, 0, lineRange.endLine - 1, 0);
}

/** Returns the lines of the editor range `range`, numbered like the lines of a stored thread. */
function editorLineRange(range: vscode.Range): LineRange {
  return { startLine: range.start.line + 1, endLine: range.end.line + 1 };
}

/**
 * Asks whether the prompt covers every thread or only those of the file in the active editor,
 * and returns the chosen threads read from `.fusen/` with the workspace folder that stores them.
 * Returns `undefined` when the person dismisses a pick or there is no workspace folder.
 */
async function pickPromptThreads(): Promise<{ workspaceRoot: string; threads: FusenThread[] } | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  const activeFileUri = editorUri?.scheme === "file" ? editorUri : undefined;
  // With nested workspace folders, every folder that contains the file can store threads on it,
  // not only the innermost one that `getWorkspaceFolder` returns.
  const activeFileWorkspaceFolders = activeFileUri
    ? workspaceFolders.filter((workspaceFolder) => relativeFilePath(workspaceFolder, activeFileUri) !== undefined)
    : [];
  const scope = await vscode.window.showQuickPick(
    [
      { label: "All comments", currentFile: false },
      // Offered only for a file that can have threads, that is, one inside a workspace folder.
      ...(activeFileUri && activeFileWorkspaceFolders.length > 0
        ? [
            {
              label: "Comments in the current file",
              description: vscode.workspace.asRelativePath(activeFileUri),
              currentFile: true,
            },
          ]
        : []),
    ],
    { placeHolder: "Comments to include in the prompt" },
  );
  if (!scope) {
    return undefined;
  }
  // Each workspace folder has its own `.fusen/` and relative paths, so one prompt covers one folder.
  const candidateWorkspaceFolders = scope.currentFile ? activeFileWorkspaceFolders : workspaceFolders;
  const workspaceFolder =
    candidateWorkspaceFolders.length === 1
      ? candidateWorkspaceFolders[0]
      : (
          await vscode.window.showQuickPick(
            candidateWorkspaceFolders.map((candidate) => ({
              label: candidate.name,
              description: candidate.uri.fsPath,
              workspaceFolder: candidate,
            })),
            { placeHolder: "Workspace folder of the comments" },
          )
        )?.workspaceFolder;
  if (!workspaceFolder) {
    return undefined;
  }
  const { threads, invalidFiles } = await readThreads(workspaceFolder.uri.fsPath);
  for (const invalidFile of invalidFiles) {
    void vscode.window.showWarningMessage(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
  }
  const activeFile = scope.currentFile && activeFileUri ? relativeFilePath(workspaceFolder, activeFileUri) : undefined;
  return {
    workspaceRoot: workspaceFolder.uri.fsPath,
    threads: activeFile === undefined ? threads : threads.filter((thread) => thread.file === activeFile),
  };
}

/** Returns the path of `fileUri` relative to `workspaceFolder` as stored in a thread, or `undefined` when the file is outside it. */
function relativeFilePath(workspaceFolder: vscode.WorkspaceFolder, fileUri: vscode.Uri): string | undefined {
  const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.split(path.sep).join("/");
}

/**
 * Returns a new comment written by the person using the editor on `file` of the workspace folder at `workspaceRoot`,
 * with the git state of the file as it is on disk now.
 */
async function humanComment(workspaceRoot: string, file: string, body: string): Promise<FusenComment> {
  return {
    id: createFusenId(),
    body,
    author: "human",
    createdAt: new Date().toISOString(),
    git: await readGitState(workspaceRoot, file),
  };
}

/** Returns how `fusenComment` is shown in the editor when it is not being edited. */
function commentView(fusenComment: FusenComment): Pick<vscode.Comment, "body" | "mode" | "author" | "timestamp"> {
  return {
    body: new vscode.MarkdownString(fusenComment.body),
    mode: vscode.CommentMode.Preview,
    author: { name: authorName(fusenComment.author) },
    timestamp: new Date(fusenComment.createdAt),
  };
}

/**
 * Returns `renderedComment` when it can be rendered again with `view`, or `undefined` when the comment needs a new object.
 * VS Code updates the body, label and timestamp of a comment it already shows but not its author (checked in 1.139.1),
 * and shows a new object as a new comment, so a comment whose author name changed needs a new object to show the new name.
 */
function reusableComment<T extends vscode.Comment>(renderedComment: T | undefined, view: Pick<vscode.Comment, "author">): T | undefined {
  return renderedComment?.author.name === view.author.name ? renderedComment : undefined;
}

/**
 * Returns the name shown as the author of a comment written by `author`, from the `fusen.humanName` and `fusen.agentName` settings.
 * The stored `author` stays `human` or `agent`; the settings only change what the editor shows.
 */
function authorName(author: FusenComment["author"]): string {
  const configuration = vscode.workspace.getConfiguration("fusen");
  // An empty setting, the default, shows the names Fusen showed before the settings existed.
  return author === "human" ? configuration.get<string>("humanName") || "Human" : configuration.get<string>("agentName") || "Agent";
}

/** Returns a handler that shows a failure of Fusen's background work with `summary`, instead of leaving it unhandled. */
function reportError(summary: string): (error: unknown) => void {
  return (error) => {
    void vscode.window.showErrorMessage(`Fusen ${summary}: ${error instanceof Error ? error.message : String(error)}`);
  };
}

import path from "node:path";
import {
  type FusenComment,
  type FusenPendingProposal,
  type FusenPendingReply,
  type FusenThread,
  createFusenId,
  createPrompt,
  deletePendingProposal,
  deleteThread,
  isPendingReply,
  pendingProposalFilePath,
  promptFilePath,
  readPendingProposals,
  readThreads,
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
  // The file watcher of `.fusen/_pending/` of each workspace folder, keyed by the folder's path.
  const proposalWatchers = new Map<string, vscode.FileSystemWatcher>();
  // Problems already reported, so that re-reading `.fusen/_pending/` on every change does not repeat them.
  const reportedProblems = new Set<string>();
  // The last change queued to the proposals; see `changeProposals`.
  let proposalChanges = Promise.resolve();

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
   */
  function render(commentThread: vscode.CommentThread): void {
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
        return Object.assign(renderedComment ?? { commentThread, fusenCommentId: fusenComment.id }, commentView(fusenComment));
      }),
      ...pendingReplies(stored).map(([proposalFilePath, reply]) =>
        Object.assign(renderedReplies.get(proposalFilePath) ?? { fusenProposalFilePath: proposalFilePath }, commentView(reply.comment), {
          label: pendingLabel,
          contextValue: proposalContextValue,
        }),
      ),
    ];
  }

  /** Writes the thread to `.fusen/` of its workspace folder and shows it in `commentThread`. */
  async function save(commentThread: vscode.CommentThread, stored: StoredThread): Promise<void> {
    await writeThread(stored.workspaceRoot, stored.fusenThread);
    storedThreads.set(commentThread, stored);
    render(commentThread);
  }

  /** Deletes the stored file of `commentThread`, if any, and removes the thread from the editor. */
  async function remove(commentThread: vscode.CommentThread): Promise<void> {
    const stored = storedThreads.get(commentThread);
    if (stored) {
      await deleteThread(stored.workspaceRoot, stored.fusenThread.id);
    }
    storedThreads.delete(commentThread);
    commentThread.dispose();
  }

  /** Creates an expanded editor thread on the lines of `fusenThread` in the workspace folder at `workspaceRoot`. */
  function createEditorThread(workspaceRoot: string, fusenThread: FusenThread): vscode.CommentThread {
    const commentThread = commentController.createCommentThread(
      vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), fusenThread.file),
      new vscode.Range(fusenThread.startLine - 1, 0, fusenThread.endLine - 1, 0),
      [],
    );
    commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return commentThread;
  }

  /** Shows the stored thread `stored` in a new editor thread. */
  function showStoredThread(stored: StoredThread): void {
    const commentThread = createEditorThread(stored.workspaceRoot, stored.fusenThread);
    storedThreads.set(commentThread, stored);
    render(commentThread);
  }

  /** Shows every thread stored under `.fusen/` of `workspaceFolders`, as it was when the workspace was last open. */
  async function restoreThreads(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    for (const workspaceFolder of workspaceFolders) {
      const { threads, invalidFiles } = await readThreads(workspaceFolder.uri.fsPath);
      for (const invalidFile of invalidFiles) {
        void vscode.window.showWarningMessage(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
      }
      for (const fusenThread of threads) {
        showStoredThread({ workspaceRoot: workspaceFolder.uri.fsPath, fusenThread });
      }
    }
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
    const { proposals, invalidFiles } = await readPendingProposals(workspaceRoot);
    for (const invalidFile of invalidFiles) {
      reportProblemOnce(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
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
        commentThread.comments = proposal.comments.map((fusenComment): FusenProposalEditorComment => ({
          fusenProposalFilePath: proposalFilePath,
          ...commentView(fusenComment),
          contextValue: proposedThreadCommentContextValue,
        }));
        proposalThreads.set(proposalFilePath, commentThread);
      }
    }
    const storedThreadsOfFolder = [...storedThreads].filter(([, stored]) => stored.workspaceRoot === workspaceRoot);
    for (const [commentThread] of storedThreadsOfFolder) {
      render(commentThread);
    }
    for (const proposal of proposals) {
      if (isPendingReply(proposal) && !storedThreadsOfFolder.some(([, stored]) => stored.fusenThread.id === proposal.threadId)) {
        reportProblemOnce(`Fusen cannot show the reply ${proposal.id} because the thread ${proposal.threadId} does not exist`);
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

  /** Watches `.fusen/_pending/` of `workspaceFolders` and shows the proposals already in it, after their threads. */
  function loadWorkspaceFolders(workspaceFolders: readonly vscode.WorkspaceFolder[]): void {
    for (const workspaceFolder of workspaceFolders) {
      const workspaceRoot = workspaceFolder.uri.fsPath;
      // The core writes a temporary file and renames it into place, so `*.json` sees only complete proposals.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, ".fusen/_pending/*.json"));
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

  context.subscriptions.push(
    statusBarItem,
    commentController,
    { dispose: () => proposalWatchers.forEach((watcher) => watcher.dispose()) },
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
      }
      loadWorkspaceFolders(added);
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
        await save(commentThread, {
          workspaceRoot: workspaceFolder.uri.fsPath,
          fusenThread: {
            version: 1,
            id: createFusenId(),
            file: path.relative(workspaceFolder.uri.fsPath, commentThread.uri.fsPath).split(path.sep).join("/"),
            startLine: commentThread.range.start.line + 1,
            endLine: commentThread.range.end.line + 1,
            comments: [humanComment(reply.text)],
          },
        });
      }),
    ),
    vscode.commands.registerCommand("fusen.reply", (reply: vscode.CommentReply) =>
      changeThread(reply.thread, async () => {
        const { workspaceRoot, fusenThread } = storedThread(reply.thread);
        await save(reply.thread, {
          workspaceRoot,
          fusenThread: { ...fusenThread, comments: [...fusenThread.comments, humanComment(reply.text)] },
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
            const { fusenThread } = storedThread(repliedThread);
            await save(repliedThread, { workspaceRoot, fusenThread: { ...fusenThread, comments: [...fusenThread.comments, proposal.comment] } });
          });
          await deletePendingProposal(workspaceRoot, proposal.id);
          await reloadProposals(workspaceRoot);
        } else {
          await writeThread(workspaceRoot, proposal);
          await deletePendingProposal(workspaceRoot, proposal.id);
          // The proposal's editor thread goes away before the approved thread appears, so the two are never shown together.
          await reloadProposals(workspaceRoot);
          showStoredThread({ workspaceRoot, fusenThread: proposal });
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

/** Returns a new comment written by the person using the editor. */
function humanComment(body: string): FusenComment {
  return { id: createFusenId(), body, author: "human", createdAt: new Date().toISOString() };
}

/** Returns how `fusenComment` is shown in the editor when it is not being edited. */
function commentView(fusenComment: FusenComment): Pick<vscode.Comment, "body" | "mode" | "author" | "timestamp"> {
  return {
    body: new vscode.MarkdownString(fusenComment.body),
    mode: vscode.CommentMode.Preview,
    author: { name: fusenComment.author === "human" ? "Human" : "Agent" },
    timestamp: new Date(fusenComment.createdAt),
  };
}

/** Returns a handler that shows a failure of Fusen's background work with `summary`, instead of leaving it unhandled. */
function reportError(summary: string): (error: unknown) => void {
  return (error) => {
    void vscode.window.showErrorMessage(`Fusen ${summary}: ${error instanceof Error ? error.message : String(error)}`);
  };
}

import path from "node:path";
import {
  type FusenComment,
  type FusenThread,
  createFusenId,
  createPrompt,
  deleteThread,
  promptFilePath,
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
   * Shows the comments of the stored thread in `commentThread`.
   * Comments keep their objects across renders, because VS Code keeps the widget of the same object,
   * including the unsaved text of a comment being edited, and recreates the widget of a new one.
   */
  function render(commentThread: vscode.CommentThread): void {
    const renderedComments = new Map(
      commentThread.comments.map((comment) => [(comment as FusenEditorComment).fusenCommentId, comment as FusenEditorComment]),
    );
    commentThread.comments = storedThread(commentThread).fusenThread.comments.map((fusenComment) => {
      const renderedComment = renderedComments.get(fusenComment.id);
      if (renderedComment?.mode === vscode.CommentMode.Editing) {
        return renderedComment;
      }
      return Object.assign(renderedComment ?? { commentThread, fusenCommentId: fusenComment.id }, {
        body: new vscode.MarkdownString(fusenComment.body),
        mode: vscode.CommentMode.Preview,
        author: { name: fusenComment.author === "human" ? "Human" : "Agent" },
        timestamp: new Date(fusenComment.createdAt),
      });
    });
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

  /** Shows every thread stored under `.fusen/` of `workspaceFolders`, as it was when the workspace was last open. */
  async function restoreThreads(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    for (const workspaceFolder of workspaceFolders) {
      const { threads, invalidFiles } = await readThreads(workspaceFolder.uri.fsPath);
      for (const invalidFile of invalidFiles) {
        void vscode.window.showWarningMessage(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
      }
      for (const fusenThread of threads) {
        const commentThread = commentController.createCommentThread(
          vscode.Uri.joinPath(workspaceFolder.uri, fusenThread.file),
          new vscode.Range(fusenThread.startLine - 1, 0, fusenThread.endLine - 1, 0),
          [],
        );
        commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        storedThreads.set(commentThread, { workspaceRoot: workspaceFolder.uri.fsPath, fusenThread });
        render(commentThread);
      }
    }
  }

  /** Restores the threads of `workspaceFolders`, reporting a failure instead of rejecting. */
  function restoreThreadsReportingErrors(workspaceFolders: readonly vscode.WorkspaceFolder[]): void {
    restoreThreads(workspaceFolders).catch((error: unknown) => {
      void vscode.window.showErrorMessage(`Fusen could not restore notes: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  context.subscriptions.push(
    statusBarItem,
    commentController,
    vscode.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
      // A thread whose folder left the workspace has no `.fusen/` to save to any more.
      const removedWorkspaceRoots = new Set(removed.map((workspaceFolder) => workspaceFolder.uri.fsPath));
      for (const [commentThread, stored] of storedThreads) {
        if (removedWorkspaceRoots.has(stored.workspaceRoot)) {
          storedThreads.delete(commentThread);
          commentThread.dispose();
        }
      }
      restoreThreadsReportingErrors(added);
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

  restoreThreadsReportingErrors(vscode.workspace.workspaceFolders ?? []);
}

export function deactivate(): void {}

/**
 * Asks whether the prompt covers every thread or only those of the file in the active editor,
 * and returns the chosen threads read from `.fusen/` with the workspace folder that stores them.
 * Returns `undefined` when the person dismisses a pick or there is no workspace folder.
 */
async function pickPromptThreads(): Promise<{ workspaceRoot: string; threads: FusenThread[] } | undefined> {
  const activeFileUri = vscode.window.activeTextEditor?.document.uri;
  const activeWorkspaceFolder =
    activeFileUri?.scheme === "file" ? vscode.workspace.getWorkspaceFolder(activeFileUri) : undefined;
  const scope = await vscode.window.showQuickPick(
    [
      { label: "All comments", file: undefined },
      // Offered only for a file that can have threads, that is, one inside a workspace folder.
      ...(activeFileUri && activeWorkspaceFolder
        ? [
            {
              label: "Comments in the current file",
              file: path.relative(activeWorkspaceFolder.uri.fsPath, activeFileUri.fsPath).split(path.sep).join("/"),
            },
          ]
        : []),
    ].map((item) => ({ ...item, description: item.file })),
    { placeHolder: "Comments to include in the prompt" },
  );
  if (!scope) {
    return undefined;
  }
  // Each workspace folder has its own `.fusen/` and relative paths, so one prompt covers one folder.
  const workspaceFolder =
    scope.file !== undefined
      ? activeWorkspaceFolder
      : vscode.workspace.workspaceFolders?.length === 1
        ? vscode.workspace.workspaceFolders[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Workspace folder of the comments" });
  if (!workspaceFolder) {
    return undefined;
  }
  const { threads, invalidFiles } = await readThreads(workspaceFolder.uri.fsPath);
  for (const invalidFile of invalidFiles) {
    void vscode.window.showWarningMessage(`Fusen skipped ${invalidFile.path}: ${invalidFile.message}`);
  }
  return {
    workspaceRoot: workspaceFolder.uri.fsPath,
    threads: scope.file === undefined ? threads : threads.filter((thread) => thread.file === scope.file),
  };
}

/** Returns a new comment written by the person using the editor. */
function humanComment(body: string): FusenComment {
  return { id: createFusenId(), body, author: "human", createdAt: new Date().toISOString() };
}

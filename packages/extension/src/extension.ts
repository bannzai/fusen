import path from "node:path";
import { type FusenComment, type FusenThread, createFusenId, deleteThread, readThreads, writeThread } from "fusen-core";
import * as vscode from "vscode";

/** A comment shown in the editor, with the ids that locate the stored comment it shows. */
interface FusenEditorComment extends vscode.Comment {
  /** The editor thread that shows this comment. */
  commentThread: vscode.CommentThread;
  /** Id of the stored comment in the thread's `.fusen/threads/<id>.json`. */
  fusenCommentId: string;
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
  const fusenThreads = new Map<vscode.CommentThread, FusenThread>();
  // The last change queued for each editor thread; see `changeThread`.
  const threadChanges = new WeakMap<vscode.CommentThread, Promise<void>>();

  /** Returns the stored thread behind `commentThread`. Throws for a thread that has not been saved yet. */
  function storedThread(commentThread: vscode.CommentThread): FusenThread {
    const fusenThread = fusenThreads.get(commentThread);
    if (!fusenThread) {
      throw new Error("This thread is not stored by Fusen");
    }
    return fusenThread;
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
    commentThread.comments = storedThread(commentThread).comments.map((fusenComment) => {
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

  /** Writes `fusenThread` to `.fusen/` and shows it in `commentThread`. */
  async function save(commentThread: vscode.CommentThread, fusenThread: FusenThread): Promise<void> {
    await writeThread(workspaceFolderPath(commentThread.uri), fusenThread);
    fusenThreads.set(commentThread, fusenThread);
    render(commentThread);
  }

  /** Deletes the stored file of `commentThread`, if any, and removes the thread from the editor. */
  async function remove(commentThread: vscode.CommentThread): Promise<void> {
    const fusenThread = fusenThreads.get(commentThread);
    if (fusenThread) {
      await deleteThread(workspaceFolderPath(commentThread.uri), fusenThread.id);
    }
    fusenThreads.delete(commentThread);
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
        fusenThreads.set(commentThread, fusenThread);
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
    vscode.workspace.onDidChangeWorkspaceFolders(({ added }) => {
      // A thread whose folder left the workspace has no `.fusen/` to save to any more.
      for (const commentThread of fusenThreads.keys()) {
        if (!vscode.workspace.getWorkspaceFolder(commentThread.uri)) {
          fusenThreads.delete(commentThread);
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
        commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        await save(commentThread, {
          version: 1,
          id: createFusenId(),
          file: path.relative(workspaceFolderPath(commentThread.uri), commentThread.uri.fsPath).split(path.sep).join("/"),
          startLine: commentThread.range.start.line + 1,
          endLine: commentThread.range.end.line + 1,
          comments: [humanComment(reply.text)],
        });
      }),
    ),
    vscode.commands.registerCommand("fusen.reply", (reply: vscode.CommentReply) =>
      changeThread(reply.thread, async () => {
        const fusenThread = storedThread(reply.thread);
        await save(reply.thread, { ...fusenThread, comments: [...fusenThread.comments, humanComment(reply.text)] });
      }),
    ),
    vscode.commands.registerCommand("fusen.editComment", (comment: FusenEditorComment) => {
      const fusenComment = storedThread(comment.commentThread).comments.find(
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
        const fusenThread = storedThread(comment.commentThread);
        await save(comment.commentThread, {
          ...fusenThread,
          comments: fusenThread.comments.map((fusenComment) =>
            fusenComment.id === comment.fusenCommentId ? { ...fusenComment, body } : fusenComment,
          ),
        });
      });
    }),
    vscode.commands.registerCommand("fusen.deleteComment", (comment: FusenEditorComment) =>
      changeThread(comment.commentThread, async () => {
        const fusenThread = storedThread(comment.commentThread);
        const comments = fusenThread.comments.filter((fusenComment) => fusenComment.id !== comment.fusenCommentId);
        // A stored thread always has a comment, so deleting the last one deletes the thread.
        if (comments.length === 0) {
          await remove(comment.commentThread);
        } else {
          await save(comment.commentThread, { ...fusenThread, comments });
        }
      }),
    ),
    vscode.commands.registerCommand("fusen.deleteThread", (commentThread: vscode.CommentThread) =>
      changeThread(commentThread, () => remove(commentThread)),
    ),
  );

  restoreThreadsReportingErrors(vscode.workspace.workspaceFolders ?? []);
}

export function deactivate(): void {}

/** Returns the file system path of the workspace folder that contains `uri`, whose `.fusen/` stores its threads. */
function workspaceFolderPath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    throw new Error(`${uri.fsPath} is not inside a workspace folder`);
  }
  return workspaceFolder.uri.fsPath;
}

/** Returns a new comment written by the person using the editor. */
function humanComment(body: string): FusenComment {
  return { id: createFusenId(), body, author: "human", createdAt: new Date().toISOString() };
}

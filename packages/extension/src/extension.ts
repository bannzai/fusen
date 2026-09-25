import path from "node:path";
import {
  type FusenComment,
  type FusenThread,
  type LineRange,
  codeAt,
  createFusenId,
  deleteThread,
  locateCode,
  moveLineRange,
  readThreads,
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
  // Threads whose code is not in their file any more. They are shown as "location unknown", are not moved by edits,
  // and keep the lines and code stored in `.fusen/`, so that they are placed again if the code comes back.
  const unlocatedThreads = new WeakSet<vscode.CommentThread>();

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
    commentThread.label = unlocatedThreads.has(commentThread) ? "Location unknown: the noted code is not in the file" : undefined;
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

  /**
   * Shows `commentThread` on `lineRange` of `fileText`, the current text of its file.
   * When `fileText` is also the text on disk (`saved`), the lines and their code are written to `.fusen/` if they changed.
   * Unsaved text is not written, because the stored line numbers must refer to the file that the MCP server and agents read.
   */
  async function place(commentThread: vscode.CommentThread, lineRange: LineRange, fileText: string, saved: boolean): Promise<void> {
    // The thread was deleted while this change waited in the queue.
    if (!storedThreads.has(commentThread)) {
      return;
    }
    unlocatedThreads.delete(commentThread);
    commentThread.range = editorRange(lineRange);
    if (saved) {
      await writeLocation(commentThread, lineRange, fileText);
    } else {
      render(commentThread);
    }
  }

  /**
   * Writes `lineRange` of `fileText`, the text of the file on disk, and the code on those lines to `.fusen/` if they changed.
   * The range shown in the editor is left as it is, because edits made after `fileText` was read have already moved it.
   */
  async function writeLocation(commentThread: vscode.CommentThread, lineRange: LineRange, fileText: string): Promise<void> {
    const stored = storedThreads.get(commentThread);
    // The thread was deleted while this change waited in the queue.
    if (!stored) {
      return;
    }
    const code = codeAt(fileText, lineRange);
    const { fusenThread } = stored;
    if (
      code &&
      (lineRange.startLine !== fusenThread.startLine ||
        lineRange.endLine !== fusenThread.endLine ||
        code.join("\n") !== fusenThread.code?.join("\n"))
    ) {
      await save(commentThread, { ...stored, fusenThread: { ...fusenThread, ...lineRange, code } });
    } else {
      render(commentThread);
    }
  }

  /**
   * Finds the stored code of `commentThread` in `fileText`, the current text of its file, and places the thread there.
   * The thread is shown as location unknown when the code is not in the file or the file (`fileText` undefined) is gone.
   */
  async function relocate(commentThread: vscode.CommentThread, fileText: string | undefined, saved: boolean): Promise<void> {
    const stored = storedThreads.get(commentThread);
    // The thread was deleted while this change waited in the queue.
    if (!stored) {
      return;
    }
    const { fusenThread } = stored;
    if (fileText !== undefined) {
      const code = fusenThread.code ?? codeAt(fileText, fusenThread);
      const lineRange = code && locateCode(fileText, code, fusenThread.startLine);
      if (lineRange) {
        await place(commentThread, lineRange, fileText, saved);
        return;
      }
    }
    unlocatedThreads.add(commentThread);
    render(commentThread);
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
      changeThreadReportingErrors(commentThread, () => relocate(commentThread, text, saved));
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
        const commentThread = commentController.createCommentThread(
          vscode.Uri.joinPath(workspaceFolder.uri, fusenThread.file),
          editorRange(fusenThread),
          [],
        );
        commentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        storedThreads.set(commentThread, { workspaceRoot: workspaceFolder.uri.fsPath, fusenThread });
        render(commentThread);
        fileUris.set(commentThread.uri.toString(), commentThread.uri);
      }
      // The files may have changed while the workspace was closed, for example by a git checkout.
      for (const fileUri of fileUris.values()) {
        await relocateThreadsOn(fileUri);
      }
    }
  }

  /** Restores the threads of `workspaceFolders`, reporting a failure instead of rejecting. */
  function restoreThreadsReportingErrors(workspaceFolders: readonly vscode.WorkspaceFolder[]): void {
    restoreThreads(workspaceFolders).catch((error: unknown) => {
      void vscode.window.showErrorMessage(`Fusen could not restore notes: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // Changes outside the editor, such as a git checkout or an agent rewriting a file, reach files that are not open only through the file system.
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher("**/*");

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
          changeThreadReportingErrors(commentThread, () => relocate(commentThread, text, true));
        }
        return;
      }
      for (const commentThread of storedThreadsOn(document.uri)) {
        if (unlocatedThreads.has(commentThread)) {
          // The edit may have brought the code back, for example by undoing its deletion. The document is not saved,
          // so the thread is only shown there until the save writes it.
          const text = document.getText();
          changeThreadReportingErrors(commentThread, () => relocate(commentThread, text, false));
          continue;
        }
        if (!commentThread.range) {
          continue;
        }
        const lineRange = contentChanges.reduce<LineRange | undefined>(
          (movedLineRange, change) =>
            movedLineRange &&
            moveLineRange(
              movedLineRange,
              change,
              contentChanges.length === 1 ? (lineIndex) => document.lineAt(lineIndex).text : undefined,
            ),
          editorLineRange(commentThread.range),
        );
        if (lineRange) {
          commentThread.range = editorRange(lineRange);
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
        const range = unlocatedThreads.has(commentThread) ? undefined : commentThread.range;
        changeThreadReportingErrors(commentThread, () =>
          range ? writeLocation(commentThread, editorLineRange(range), text) : relocate(commentThread, text, true),
        );
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      // Edits discarded when the document was closed without saving may have moved its threads.
      relocateThreadsOnReportingErrors(document.uri);
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
        changeThreadReportingErrors(commentThread, () => relocate(commentThread, undefined, true));
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
        await save(commentThread, {
          workspaceRoot: workspaceFolder.uri.fsPath,
          fusenThread: {
            version: 1,
            id: createFusenId(),
            file: path.relative(workspaceFolder.uri.fsPath, commentThread.uri.fsPath).split(path.sep).join("/"),
            ...lineRange,
            // Unsaved code is not in the file on disk, so it is left out until saving the document writes the code of the lines.
            code: document.isDirty ? undefined : codeAt(document.getText(), lineRange),
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
  );

  restoreThreadsReportingErrors(vscode.workspace.workspaceFolders ?? []);
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

/** Returns a new comment written by the person using the editor. */
function humanComment(body: string): FusenComment {
  return { id: createFusenId(), body, author: "human", createdAt: new Date().toISOString() };
}

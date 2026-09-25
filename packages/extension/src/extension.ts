import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  // Visible marker that the extension host activated Fusen; the E2E test asserts on it.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.name = "Fusen";
  statusBarItem.text = "$(note) Fusen";
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

export function deactivate(): void {}

import * as vscode from "vscode";
import { registerDetectQueries } from "./commands/detectQueries";

export function activate(context: vscode.ExtensionContext): void {
  registerDetectQueries(context);
}

export function deactivate(): void {
  // Disposables are managed by ExtensionContext.
}

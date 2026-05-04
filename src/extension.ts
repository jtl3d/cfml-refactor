import * as vscode from "vscode";
import { registerConvertQueries } from "./commands/convertQueries";
import { registerDetectQueries } from "./commands/detectQueries";

export function activate(context: vscode.ExtensionContext): void {
  registerDetectQueries(context);
  registerConvertQueries(context);
}

export function deactivate(): void {
  // Disposables are managed by ExtensionContext.
}

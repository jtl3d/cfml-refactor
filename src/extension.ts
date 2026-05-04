import * as vscode from "vscode";
import { registerConvertQueries } from "./commands/convertQueries";
import { registerDetectQueries } from "./commands/detectQueries";
import { registerHoistQueries } from "./commands/hoistQueries";

export function activate(context: vscode.ExtensionContext): void {
  registerDetectQueries(context);
  registerConvertQueries(context);
  registerHoistQueries(context);
}

export function deactivate(): void {
  // Disposables are managed by ExtensionContext.
}

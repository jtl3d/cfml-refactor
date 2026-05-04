import * as vscode from "vscode";
import { registerConvertQueries } from "./commands/convertQueries";
import { registerDetectQueries } from "./commands/detectQueries";
import { registerFindSimilarQueries } from "./commands/findSimilarQueries";
import { registerHoistQueries } from "./commands/hoistQueries";
import { registerIndexWorkspace } from "./commands/indexWorkspace";

export function activate(context: vscode.ExtensionContext): void {
  registerDetectQueries(context);
  registerConvertQueries(context);
  registerHoistQueries(context);
  registerIndexWorkspace(context);
  registerFindSimilarQueries(context);
}

export function deactivate(): void {
  // Disposables are managed by ExtensionContext.
}

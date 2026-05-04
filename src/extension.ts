import * as vscode from "vscode";
import { registerConvertQueries } from "./commands/convertQueries";
import { registerDetectQueries } from "./commands/detectQueries";
import { registerFindExtractableFunctions } from "./commands/findExtractableFunctions";
import { registerFindExtractableFunctionsWorkspace } from "./commands/findExtractableFunctionsWorkspace";
import { registerFindSimilarQueries } from "./commands/findSimilarQueries";
import { registerHoistQueries } from "./commands/hoistQueries";
import { registerIndexWorkspace } from "./commands/indexWorkspace";

export function activate(context: vscode.ExtensionContext): void {
  registerDetectQueries(context);
  registerConvertQueries(context);
  registerHoistQueries(context);
  registerIndexWorkspace(context);
  registerFindSimilarQueries(context);
  registerFindExtractableFunctions(context);
  registerFindExtractableFunctionsWorkspace(context);
}

export function deactivate(): void {
  // Disposables are managed by ExtensionContext.
}

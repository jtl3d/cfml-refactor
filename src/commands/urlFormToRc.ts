import * as path from "path";
import * as vscode from "vscode";
import { rewriteUrlFormToRc } from "../transform/urlFormToRc";

export function registerUrlFormToRc(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel(
    "CFML Refactor: url/form → rc"
  );
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.convertUrlFormToRc",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a handler file before running url/form → rc."
        );
        return;
      }
      const doc = editor.document;
      const source = doc.getText();
      const result = rewriteUrlFormToRc(source);

      const rel = vscode.workspace.asRelativePath(doc.uri, false);
      const display = rel || path.basename(doc.fileName);
      channel.clear();
      channel.appendLine(`=== ${display} ===`);
      channel.appendLine(`url. rewrites: ${result.urlRewrites}`);
      channel.appendLine(`form. rewrites: ${result.formRewrites}`);
      if (result.skippedFunctions.length > 0) {
        channel.appendLine(`Skipped functions:`);
        for (const s of result.skippedFunctions) {
          channel.appendLine(`  - ${s.name}: ${s.reason}`);
        }
      }
      if (result.collisions.length > 0) {
        channel.appendLine(`Collisions detected (url/form share same key):`);
        for (const c of result.collisions) {
          channel.appendLine(`  - ${c.functionName}: ${c.key}`);
        }
      }
      channel.show(true);

      if (result.urlRewrites + result.formRewrites === 0) {
        vscode.window.showInformationMessage(
          "CFML Refactor: no url/form references found in rc-bearing functions."
        );
        return;
      }

      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(source.length)
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, fullRange, result.output);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage(
          "CFML Refactor: failed to apply url/form rewrites."
        );
        return;
      }
      vscode.window.showInformationMessage(
        `CFML Refactor: rewrote ${result.urlRewrites} url and ${result.formRewrites} form references to rc.`
      );
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

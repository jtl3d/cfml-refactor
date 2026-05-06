import * as path from "path";
import * as vscode from "vscode";
import { renameQueriesInSource } from "../transform/renameQueries";

export function registerRenameQueries(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor: Rename");
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.renameQueriesToPrc",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a file before running Rename Query Variables."
        );
        return;
      }

      const doc = editor.document;
      const source = doc.getText();
      const result = renameQueriesInSource(source);

      const rel = vscode.workspace.asRelativePath(doc.uri, false);
      const display = rel || path.basename(doc.fileName);
      channel.clear();
      channel.appendLine(`=== ${display} ===`);

      if (result.renamed.length === 0) {
        channel.appendLine("No queryExecute(...) assignments found to rename.");
        channel.show(true);
        vscode.window.showInformationMessage(
          "CFML Refactor: no queryExecute(...) assignments to rename."
        );
        return;
      }

      for (const r of result.renamed) {
        const scope = r.enclosingFunctionRange
          ? `(scope: function body @ offset ${r.enclosingFunctionRange.start})`
          : "(scope: file)";
        channel.appendLine(`Rename: ${r.target} -> ${r.replacement} ${scope}`);
      }
      channel.appendLine(
        `Replaced ${result.referenceMatches} ${result.referenceMatches === 1 ? "reference" : "references"}.`
      );
      channel.show(true);

      // Apply the rename as a single full-document edit. No preview prompt —
      // users review via git/source-control diff per the task's design.
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(source.length)
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, fullRange, result.output);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage(
          "CFML Refactor: failed to apply rename edits."
        );
        return;
      }
      vscode.window.showInformationMessage(
        `CFML Refactor: renamed ${result.renamed.length} ${result.renamed.length === 1 ? "query" : "queries"} to prc.* form.`
      );
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

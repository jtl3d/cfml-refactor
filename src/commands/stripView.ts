import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { stripView } from "../transform/stripView";

export function registerStripView(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel(
    "CFML Refactor: Strip View"
  );
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.stripViewToLogic",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a view file before running Strip View to Logic."
        );
        return;
      }

      const doc = editor.document;
      const sourcePath = doc.uri.fsPath;
      const source = doc.getText();
      const result = stripView(source);

      const ext = path.extname(sourcePath);
      const base = path.basename(sourcePath, ext);
      const outPath = path.join(path.dirname(sourcePath), `${base}_logic${ext}`);
      fs.writeFileSync(outPath, result.output, "utf8");

      const rel = vscode.workspace.asRelativePath(doc.uri, false);
      channel.clear();
      channel.appendLine(`=== ${rel || path.basename(sourcePath)} → logic ===`);
      channel.appendLine(`Output: ${outPath}`);
      channel.appendLine(`CFML constructs kept: ${result.cfConstructsKept}`);
      channel.appendLine(`Comments kept: ${result.commentsKept}`);
      channel.appendLine(`HTML tags stripped: ${result.htmlTagsStripped}`);
      channel.show(true);

      const opened = await vscode.workspace.openTextDocument(outPath);
      await vscode.window.showTextDocument(opened, { preview: false });

      vscode.window.showInformationMessage(
        `CFML Refactor: wrote ${path.basename(outPath)} ` +
          `(${result.htmlTagsStripped} HTML tags stripped).`
      );
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

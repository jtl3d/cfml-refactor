import * as path from "path";
import * as vscode from "vscode";
import {
  hoistDocument,
  type ClassifiedCall,
  type HoistResult
} from "../transform/hoistQueries";

export function registerHoistQueries(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.hoistQueries",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a file before running Hoist Queries."
        );
        return;
      }

      const doc = editor.document;
      const source = doc.getText();
      const tabUnit = computeTabUnit(editor);

      const result = hoistDocument(source, { tabUnit });

      writeLog(channel, doc, result);
      channel.show(true);

      if (result.error) {
        vscode.window.showErrorMessage(`CFML Refactor: ${result.error}`);
        return;
      }

      if (result.noChange || result.output === source) {
        vscode.window.showInformationMessage(
          "CFML Refactor: nothing to hoist."
        );
        return;
      }

      const previewed = await previewAndConfirm(doc, result.output);
      if (!previewed) return;

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(source.length)
      );
      edit.replace(doc.uri, fullRange, result.output, {
        needsConfirmation: false,
        label: "Hoist queries to top of file"
      });
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage(
          "CFML Refactor: failed to apply hoist edit."
        );
      }
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

async function previewAndConfirm(
  doc: vscode.TextDocument,
  newText: string
): Promise<boolean> {
  const original = doc.uri;
  const proposed = await vscode.workspace.openTextDocument({
    language: doc.languageId,
    content: newText
  });
  const title = `${path.basename(doc.fileName)} (hoist preview)`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    original,
    proposed.uri,
    title
  );
  const choice = await vscode.window.showInformationMessage(
    "CFML Refactor: apply hoist edits?",
    { modal: true },
    "Apply",
    "Cancel"
  );
  return choice === "Apply";
}

function computeTabUnit(editor: vscode.TextEditor): string {
  const opts = editor.options;
  if (opts.insertSpaces === false) return "\t";
  const size = typeof opts.tabSize === "number" ? opts.tabSize : 4;
  return " ".repeat(size);
}

function writeLog(
  channel: vscode.OutputChannel,
  doc: vscode.TextDocument,
  result: HoistResult
): void {
  channel.clear();
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const display = rel || path.basename(doc.fileName);
  channel.appendLine(`=== ${display} ===`);
  if (result.error) {
    channel.appendLine(`ERROR: ${result.error}`);
    return;
  }
  channel.appendLine(
    `Hoisted: ${result.hoisted.length} ${plural(result.hoisted.length, "query", "queries")}` +
      (result.hoisted.length > 0
        ? ` (${result.hoisted.map((h) => "prc." + h.prcVar).join(", ")})`
        : "")
  );
  channel.appendLine(
    `Conditionally hoisted: ${result.conditionallyHoisted.length} ${plural(result.conditionallyHoisted.length, "query", "queries")}` +
      (result.conditionallyHoisted.length > 0
        ? ` (${result.conditionallyHoisted
            .map(
              (h) =>
                "prc." +
                h.prcVar +
                (h.branchCondition ? ` if ${h.branchCondition}` : "")
            )
            .join(", ")})`
        : "")
  );
  const reportable = result.skipped.filter((s) => !s.noHoistMarker);
  channel.appendLine(
    `Skipped: ${reportable.length} ${plural(reportable.length, "query", "queries")}`
  );
  for (const s of reportable) {
    const line = doc.positionAt(s.statementRange.start).line + 1;
    channel.appendLine(`  - prc.${s.prcVar} (line ${line}): ${s.reason ?? "n/a"}`);
  }
  channel.appendLine("Safety checks: PASSED");
  for (const w of result.warnings) channel.appendLine(`Warning: ${w}`);
}

function plural(n: number, s: string, p: string): string {
  return n === 1 ? s : p;
}

export type { ClassifiedCall };

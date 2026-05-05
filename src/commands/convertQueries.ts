import * as path from "path";
import * as vscode from "vscode";
import { analyze } from "../analyzer/findQueries";
import { parse } from "../parser/parse";
import {
  shouldSkipTransform,
  transformQuery,
  type QueryTransformation,
  type SkippedItem,
  type TransformOptions
} from "../transform/convertQuery";

export function registerConvertQueries(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.convertQueriesInPlace",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a file before running Convert Queries."
        );
        return;
      }

      const doc = editor.document;
      const source = doc.getText();
      const parsed = parse(source);
      const result = analyze(parsed);

      const tabUnit = computeTabUnit(editor);
      const cfg = vscode.workspace.getConfiguration("cfml-refactor");
      const defaultDatasourcePatterns = cfg.get<string[]>(
        "defaultDatasourcePatterns",
        []
      );
      const transformOpts: TransformOptions = {
        tabUnit,
        defaultDatasourcePatterns
      };

      const edit = new vscode.WorkspaceEdit();
      const transformations: Array<{ q: typeof result.queries[number]; t: QueryTransformation }> = [];
      const skipped: SkippedItem[] = [];

      for (const q of result.queries) {
        const skip = shouldSkipTransform(q);
        if (skip) {
          skipped.push({
            name: q.name,
            range: q.range,
            reason: skip.reason
          });
          continue;
        }
        const t = transformQuery(q, source, transformOpts);
        const range = new vscode.Range(
          doc.positionAt(t.range.start),
          doc.positionAt(t.range.end)
        );
        edit.replace(doc.uri, range, t.replacement, {
          needsConfirmation: true,
          label: `Convert <cfquery> "${q.name}"`
        });
        transformations.push({ q, t });
      }

      for (const s of result.skipped) {
        skipped.push({
          name: s.name,
          range: s.range,
          reason: analyzerSkipText(s.reason)
        });
      }

      writeLog(channel, doc, transformations, skipped);
      channel.show(true);
      const transformed = transformations.length;

      if (transformed === 0) {
        vscode.window.showInformationMessage(
          "CFML Refactor: nothing to convert."
        );
        return;
      }

      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage(
          "CFML Refactor: failed to apply edits."
        );
      }
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

function computeTabUnit(editor: vscode.TextEditor): string {
  const opts = editor.options;
  if (opts.insertSpaces === false) return "\t";
  const size = typeof opts.tabSize === "number" ? opts.tabSize : 4;
  return " ".repeat(size);
}

function analyzerSkipText(reason: string): string {
  switch (reason) {
    case "magic-comment":
      return "skipped via @cfml-refactor:skip";
    case "qoq":
      return 'Query of Queries (dbtype="query")';
    case "inside-comment":
      return "inside CFML comment";
    default:
      return reason;
  }
}

function writeLog(
  channel: vscode.OutputChannel,
  doc: vscode.TextDocument,
  transformations: Array<{ q: { name: string; range: { start: number } }; t: QueryTransformation }>,
  skipped: SkippedItem[]
): void {
  channel.clear();
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const display = rel || path.basename(doc.fileName);
  channel.appendLine(`=== ${display} ===`);
  const transformed = transformations.length;
  channel.appendLine(
    `Converted ${transformed} ${transformed === 1 ? "query" : "queries"} to queryExecute`
  );
  transformations.forEach(({ q, t }, idx) => {
    const line = doc.positionAt(q.range.start).line + 1;
    const styleLabel = describeStyle(t.style);
    channel.appendLine(
      `[${idx + 1}] ${q.name} (line ${line}) — converted with ${styleLabel}`
    );
    if (t.styleReason) {
      channel.appendLine(`    Reason: ${t.styleReason}`);
    }
  });
  if (skipped.length > 0) {
    channel.appendLine("");
    for (const s of skipped) {
      const line = doc.positionAt(s.range.start).line + 1;
      channel.appendLine(
        `SKIPPED: ${s.name ?? "(unnamed)"} (line ${line}) — reason: ${s.reason}`
      );
    }
  }
}

function describeStyle(style: QueryTransformation["style"]): string {
  switch (style) {
    case "ternary":
      return "Style A (ternary)";
    case "variable-based":
      return "Style B (variable-based)";
    case "phase2":
    default:
      return "Phase 2";
  }
}

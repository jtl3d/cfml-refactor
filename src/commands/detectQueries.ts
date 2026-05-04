import * as path from "path";
import * as vscode from "vscode";
import { analyze } from "../analyzer/findQueries";
import type {
  AnalysisResult,
  QueryInfo,
  SkippedQuery
} from "../analyzer/types";
import { parse } from "../parser/parse";

export function registerDetectQueries(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  const diagnostics =
    vscode.languages.createDiagnosticCollection("cfml-refactor");

  context.subscriptions.push(channel, diagnostics);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.detectQueries",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a file before running Detect Queries."
        );
        return;
      }
      const doc = editor.document;
      const source = doc.getText();
      const parsed = parse(source);
      const result = analyze(parsed);

      writeReport(channel, doc, result);
      publishDiagnostics(diagnostics, doc, result);
      channel.show(true);
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

function writeReport(
  channel: vscode.OutputChannel,
  doc: vscode.TextDocument,
  result: AnalysisResult
): void {
  channel.clear();
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const display = rel || path.basename(doc.fileName);
  channel.appendLine(`File: ${display}`);
  channel.appendLine(
    `Found ${result.queries.length} ${pluralize(result.queries.length, "query", "queries")}:`
  );
  channel.appendLine("");

  result.queries.forEach((q, idx) => {
    const line = doc.positionAt(q.range.start).line + 1;
    channel.appendLine(`[${idx + 1}] ${q.name} (line ${line})`);
    channel.appendLine(`    Context: ${describeContext(q)}`);
    channel.appendLine(`    Params: ${describeParams(q)}`);
    channel.appendLine(
      `    Conditional SQL: ${q.hasConditionalSQL ? "yes" : "no"}`
    );
    if (q.datasource) {
      channel.appendLine(`    Datasource: ${q.datasource}`);
    }
    channel.appendLine(`    → ${suggestion(q)}`);
    channel.appendLine("");
  });

  if (result.skipped.length > 0) {
    channel.appendLine(
      `Skipped ${result.skipped.length} ${pluralize(result.skipped.length, "query", "queries")}:`
    );
    result.skipped.forEach((s) => {
      const line = doc.positionAt(s.range.start).line + 1;
      channel.appendLine(
        `  - ${s.name ?? "(unnamed)"} (line ${line}) — ${describeSkip(s)}`
      );
    });
    channel.appendLine("");
  }

  if (result.cfscriptBlocks > 0) {
    channel.appendLine(
      `Note: ${result.cfscriptBlocks} <cfscript> ${pluralize(result.cfscriptBlocks, "block", "blocks")} not scanned in Phase 1.`
    );
  }
}

function describeContext(q: QueryInfo): string {
  const parts: string[] = [];
  if (q.context.insideLoop) {
    let label = `inside <cfloop>`;
    if (q.context.loopType) {
      const detail =
        q.context.loopType === "query" && q.context.loopQueryName
          ? `query loop over ${q.context.loopQueryName}`
          : `${q.context.loopType} loop`;
      label = `inside <cfloop> (${detail})`;
    }
    parts.push(label);
  }
  if (q.context.insideConditional) parts.push("inside <cfif>");
  if (q.context.insideOutput) parts.push("inside <cfoutput>");
  if (parts.length === 0) return "top-level";
  return parts.join(", ");
}

function describeParams(q: QueryInfo): string {
  if (q.qparams.length === 0) return "0";
  const named = q.qparams
    .map((p) => p.name)
    .filter((n): n is string => Boolean(n));
  if (named.length === q.qparams.length) {
    return `${q.qparams.length} (named: ${named.join(", ")})`;
  }
  if (named.length === 0) {
    return `${q.qparams.length} (positional)`;
  }
  return `${q.qparams.length} (mixed; named: ${named.join(", ")})`;
}

function suggestion(q: QueryInfo): string {
  if (q.context.insideLoop && q.hasConditionalSQL) {
    return "Needs loop restructuring + dynamic SQL handling";
  }
  if (q.context.insideLoop) {
    return "Needs loop restructuring";
  }
  if (q.hasConditionalSQL) {
    return "Needs dynamic SQL handling";
  }
  if (q.context.insideConditional) {
    return "Needs conditional preservation";
  }
  return "Safe to transform";
}

function describeSkip(s: SkippedQuery): string {
  switch (s.reason) {
    case "magic-comment":
      return "skipped via @cfml-refactor:skip";
    case "qoq":
      return "Query of Queries (dbtype=\"query\")";
    case "inside-comment":
      return "inside CFML comment";
  }
}

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  doc: vscode.TextDocument,
  result: AnalysisResult
): void {
  const diags: vscode.Diagnostic[] = result.queries.map((q) => {
    const range = new vscode.Range(
      doc.positionAt(q.range.start),
      doc.positionAt(q.range.end)
    );
    const diag = new vscode.Diagnostic(
      range,
      `cfquery "${q.name}": ${describeContext(q)} — ${suggestion(q)}`,
      vscode.DiagnosticSeverity.Information
    );
    diag.source = "cfml-refactor";
    return diag;
  });
  collection.set(doc.uri, diags);
}

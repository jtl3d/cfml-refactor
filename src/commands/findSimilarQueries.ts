import * as path from "path";
import * as vscode from "vscode";
import { extractQueriesFromFile } from "../index/extractFile";
import { findMatches } from "../index/match";
import type {
  IndexedQuery,
  IndexFile,
  QueryMatch
} from "../index/types";
import {
  ensureIndexLoaded,
  readNormalizationConfig
} from "./indexWorkspace";

const DIAGNOSTIC_SOURCE = "cfml-refactor";

let diagnostics: vscode.DiagnosticCollection | undefined;

export function registerFindSimilarQueries(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  context.subscriptions.push(channel);

  diagnostics = vscode.languages.createDiagnosticCollection(
    "cfml-refactor.similar"
  );
  context.subscriptions.push(diagnostics);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.findSimilarQueries",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a file before running Find Similar Queries."
        );
        return;
      }
      const index = await ensureIndexLoaded();
      if (!index) {
        const choice = await vscode.window.showInformationMessage(
          "CFML Refactor: no index available. Build it now?",
          "Index Workspace",
          "Cancel"
        );
        if (choice === "Index Workspace") {
          await vscode.commands.executeCommand("cfml-refactor.indexWorkspace");
        }
        return;
      }
      await runFindSimilar(editor, index, channel, context);
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

async function runFindSimilar(
  editor: vscode.TextEditor,
  index: IndexFile,
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<void> {
  const doc = editor.document;
  const cfg = vscode.workspace.getConfiguration("cfml-refactor");
  const includeOverlap = cfg.get<boolean>("suggestSimilarQueries", false);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage(
      "CFML Refactor: open a folder before running Find Similar Queries."
    );
    return;
  }
  const rel = vscode.workspace
    .asRelativePath(doc.uri, false)
    .replace(/\\/g, "/");

  const norm = readNormalizationConfig();
  const fileQueries = extractQueriesFromFile(doc.getText(), {
    filePath: rel,
    normalization: norm
  });

  const indexById = new Map<string, IndexedQuery>();
  for (const q of index.queries) indexById.set(q.id, q);

  const sections: SectionData[] = [];
  for (const q of fileQueries) {
    const merged = mergeIntoIndex(index, q);
    const matches = findMatches(q, merged, {
      includeTableOverlap: includeOverlap
    });
    const otherFile = matches.filter((m) => m.query.filePath !== rel);
    sections.push({ query: q, matches: otherFile });
  }

  publishDiagnostics(doc, sections);
  writeChannelLog(channel, rel, sections);
  channel.show(true);

  if (sections.some((s) => s.matches.length > 0)) {
    showWebview(context, doc, rel, sections);
  } else {
    vscode.window.showInformationMessage(
      `CFML Refactor: no similar queries found for ${path.basename(doc.fileName)}.`
    );
  }
}

interface SectionData {
  query: IndexedQuery;
  matches: QueryMatch[];
}

function mergeIntoIndex(index: IndexFile, q: IndexedQuery): IndexFile {
  if (index.queries.some((iq) => iq.id === q.id)) return index;
  const queries = [...index.queries, q];
  const fingerprintMap: Record<string, string[]> = {};
  for (const x of queries) {
    if (!fingerprintMap[x.sqlFingerprint]) fingerprintMap[x.sqlFingerprint] = [];
    fingerprintMap[x.sqlFingerprint].push(x.id);
  }
  return { ...index, queries, fingerprintMap };
}

function publishDiagnostics(
  doc: vscode.TextDocument,
  sections: SectionData[]
): void {
  if (!diagnostics) return;
  const diags: vscode.Diagnostic[] = [];
  for (const s of sections) {
    const surface = s.matches.filter(
      (m) => m.type === "EXACT" || m.type === "STRUCTURAL"
    );
    if (surface.length === 0) continue;
    const range = new vscode.Range(
      doc.positionAt(s.query.range.start),
      doc.positionAt(s.query.range.end)
    );
    const top = surface[0];
    const line = lineFromOffset(top.query.rawSQL, top.query.range.start);
    const lineHint = line >= 0 ? `:${line + 1}` : "";
    let msg = `Similar query found in ${top.query.filePath}${lineHint}\n  (${matchTypeText(top.type)})\n  Variable name there: ${top.query.variableName}`;
    if (s.query.isConditionalSQL) {
      msg += `\n  Note: this query has conditional SQL — match confidence reduced.`;
    }
    if (surface.length > 1) {
      msg += `\n  …${surface.length - 1} more match${surface.length - 1 === 1 ? "" : "es"} elsewhere.`;
    }
    const d = new vscode.Diagnostic(
      range,
      msg,
      vscode.DiagnosticSeverity.Information
    );
    d.source = DIAGNOSTIC_SOURCE;
    diags.push(d);
  }
  diagnostics.set(doc.uri, diags);
}

function lineFromOffset(_text: string, _offset: number): number {
  return -1;
}

function matchTypeText(t: string): string {
  if (t === "EXACT") return "exact match after normalization";
  if (t === "STRUCTURAL") return "structural match";
  return "table-overlap match";
}

function writeChannelLog(
  channel: vscode.OutputChannel,
  rel: string,
  sections: SectionData[]
): void {
  channel.appendLine("");
  channel.appendLine(`=== ${rel} ===`);
  channel.appendLine(
    `Analyzing ${sections.length} ${sections.length === 1 ? "query" : "queries"}:`
  );
  for (const s of sections) {
    const surface = s.matches.filter(
      (m) => m.type === "EXACT" || m.type === "STRUCTURAL"
    );
    const overlaps = s.matches.filter((m) => m.type === "TABLE-OVERLAP");
    if (surface.length === 0 && overlaps.length === 0) {
      channel.appendLine(`  - ${s.query.variableName}: no matches`);
      continue;
    }
    if (surface.length > 0) {
      const exact = surface.filter((m) => m.type === "EXACT").length;
      const struct = surface.filter((m) => m.type === "STRUCTURAL").length;
      const parts: string[] = [];
      if (exact > 0) parts.push(`${exact} EXACT match${exact === 1 ? "" : "es"}`);
      if (struct > 0) parts.push(`${struct} STRUCTURAL match${struct === 1 ? "" : "es"}`);
      channel.appendLine(`  - ${s.query.variableName}: ${parts.join(", ")}`);
      for (const m of surface) {
        channel.appendLine(
          `    → ${m.query.filePath} (${m.query.variableName}) [${m.query.context}]`
        );
      }
    }
    if (overlaps.length > 0) {
      channel.appendLine(
        `    (${overlaps.length} TABLE-OVERLAP match${overlaps.length === 1 ? "" : "es"} suppressed by config)`
      );
    }
  }
}

function showWebview(
  _context: vscode.ExtensionContext,
  doc: vscode.TextDocument,
  rel: string,
  sections: SectionData[]
): void {
  const panel = vscode.window.createWebviewPanel(
    "cfmlRefactorReuse",
    `CFML Query Reuse — ${path.basename(doc.fileName)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false }
  );
  panel.webview.html = renderHtml(rel, sections);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.command === "open" && typeof msg.file === "string") {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const target = vscode.Uri.file(path.join(root, msg.file));
      const targetDoc = await vscode.workspace.openTextDocument(target);
      const editor = await vscode.window.showTextDocument(targetDoc, {
        preview: false
      });
      if (typeof msg.start === "number") {
        const pos = targetDoc.positionAt(msg.start);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
        editor.selection = new vscode.Selection(pos, pos);
      }
    }
  });
}

function renderHtml(rel: string, sections: SectionData[]): string {
  const sectionHtml = sections
    .map((s) => renderSection(s))
    .join("\n");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
  h1 { font-size: 1.1em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  h2 { font-size: 1em; margin-top: 16px; }
  .empty { opacity: 0.6; font-style: italic; }
  .match { margin: 4px 0 4px 16px; }
  .badge { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 0.85em; margin-right: 6px; }
  .EXACT { background: var(--vscode-textLink-foreground); color: var(--vscode-editor-background); }
  .STRUCTURAL { background: var(--vscode-textPreformat-foreground); color: var(--vscode-editor-background); }
  .TABLE-OVERLAP { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 3px; white-space: pre-wrap; }
  a.file { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .diff div { background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; white-space: pre-wrap; }
  .label { font-size: 0.8em; opacity: 0.7; margin-bottom: 2px; }
</style>
</head>
<body>
  <h1>CFML Query Reuse — ${escapeHtml(rel)}</h1>
  ${sectionHtml || '<p class="empty">No queries in this file.</p>'}
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('a.file').forEach((el) => {
      el.addEventListener('click', () => {
        vscode.postMessage({
          command: 'open',
          file: el.dataset.file,
          start: parseInt(el.dataset.start, 10)
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderSection(s: SectionData): string {
  const snippet = s.query.rawSQL.trim().split("\n").slice(0, 6).join("\n");
  if (s.matches.length === 0) {
    return `
<h2>${escapeHtml(s.query.variableName)} (${s.query.source})</h2>
<pre>${escapeHtml(snippet)}</pre>
<p class="empty">No matches elsewhere in workspace.</p>`;
  }
  const matches = s.matches
    .map((m) => renderMatch(s.query, m))
    .join("\n");
  return `
<h2>${escapeHtml(s.query.variableName)} (${s.query.source})</h2>
<pre>${escapeHtml(snippet)}</pre>
<div>${matches}</div>`;
}

function renderMatch(target: IndexedQuery, m: QueryMatch): string {
  const q = m.query;
  return `
<div class="match">
  <span class="badge ${m.type}">${m.type}</span>
  <a class="file" data-file="${escapeHtml(q.filePath)}" data-start="${q.range.start}">${escapeHtml(q.filePath)}</a>
  — variable: <code>${escapeHtml(q.variableName)}</code>
  — context: <code>${q.context}</code>
  <div class="diff">
    <div><div class="label">this file (normalized)</div>${escapeHtml(target.normalizedSQL)}</div>
    <div><div class="label">${escapeHtml(q.filePath)} (normalized)</div>${escapeHtml(q.normalizedSQL)}</div>
  </div>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

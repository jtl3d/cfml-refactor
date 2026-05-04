import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import {
  analyzeViewCalls,
  type ViewCallAnalysis
} from "../analyzer/analyzeViewCalls";
import type {
  CallCategory,
  ClassifiedCall
} from "../analyzer/classifyCall";
import { categoryLabel, readConfig } from "./findExtractableFunctions";
import { ensureIndexLoaded } from "./indexWorkspace";

export function registerFindExtractableFunctionsWorkspace(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.findExtractableFunctionsWorkspace",
    async () => {
      await runWorkspace(context, channel);
    }
  );
  context.subscriptions.push(cmd);
  return cmd;
}

interface FileResult {
  filePath: string;
  analysis: ViewCallAnalysis;
}

async function runWorkspace(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage(
      "CFML Refactor: open a folder before running the workspace scan."
    );
    return;
  }
  const cfg = readConfig();

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  context.subscriptions.push(status);
  status.text = "$(sync~spin) CFML Refactor: Scanning views...";
  status.show();

  const matches: vscode.Uri[] = [];
  for (const pattern of cfg.viewFolderPatterns) {
    const found = await vscode.workspace.findFiles(
      pattern,
      "**/{node_modules,dist,build,.git}/**"
    );
    for (const uri of found) matches.push(uri);
  }
  const dedup = new Map<string, vscode.Uri>();
  for (const u of matches) dedup.set(u.fsPath, u);

  const results: FileResult[] = [];
  let i = 0;
  for (const [, uri] of dedup) {
    i++;
    status.text = `$(sync~spin) CFML Refactor: Scanning views... ${i}/${dedup.size}`;
    try {
      const source = await fs.readFile(uri.fsPath, "utf8");
      const rel = path.relative(root, uri.fsPath).replace(/\\/g, "/");
      const analysis = analyzeViewCalls(source, rel, cfg);
      results.push({ filePath: rel, analysis });
    } catch {
      // unreadable — skip
    }
  }
  status.hide();
  status.dispose();

  const index = await ensureIndexLoaded();
  const aggregate = aggregateResults(results);
  writeChannelLog(channel, results, aggregate);
  channel.show(true);
  showWebview(context, results, aggregate, index !== undefined);
}

interface AggregateData {
  totals: Record<CallCategory, number>;
  perFileCounts: Array<{
    filePath: string;
    total: number;
    perCat: Record<CallCategory, number>;
  }>;
  topByName: Array<{
    name: string;
    category: CallCategory;
    count: number;
    files: number;
  }>;
}

function aggregateResults(results: FileResult[]): AggregateData {
  const totals: Record<CallCategory, number> = {
    "view-safe": 0,
    "view-possible": 0,
    "handler-logic": 0,
    "service-call": 0
  };
  const perFile: AggregateData["perFileCounts"] = [];
  const byName = new Map<
    string,
    { category: CallCategory; count: number; files: Set<string> }
  >();

  for (const r of results) {
    const perCat: Record<CallCategory, number> = {
      "view-safe": 0,
      "view-possible": 0,
      "handler-logic": 0,
      "service-call": 0
    };
    for (const c of r.analysis.classified) {
      totals[c.category]++;
      perCat[c.category]++;
      const key = aggregateKey(c);
      const cur = byName.get(key);
      if (cur) {
        cur.count++;
        cur.files.add(r.filePath);
      } else {
        byName.set(key, {
          category: c.category,
          count: 1,
          files: new Set([r.filePath])
        });
      }
    }
    perFile.push({
      filePath: r.filePath,
      total: r.analysis.totalCalls,
      perCat
    });
  }

  perFile.sort(
    (a, b) =>
      b.perCat["service-call"] +
      b.perCat["handler-logic"] -
      (a.perCat["service-call"] + a.perCat["handler-logic"])
  );

  const topByName = [...byName.entries()]
    .map(([name, v]) => ({
      name,
      category: v.category,
      count: v.count,
      files: v.files.size
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);

  return { totals, perFileCounts: perFile, topByName };
}

function aggregateKey(c: ClassifiedCall): string {
  if (c.call.receiver) {
    return `${c.call.receiver}.${c.call.name}`;
  }
  return c.call.name;
}

function writeChannelLog(
  channel: vscode.OutputChannel,
  results: FileResult[],
  agg: AggregateData
): void {
  channel.appendLine("");
  channel.appendLine("=== Function call extraction candidates (workspace) ===");
  channel.appendLine(`Scanned ${results.length} view files.`);
  channel.appendLine(
    `  Likely service/model calls: ${agg.totals["service-call"]}`
  );
  channel.appendLine(
    `  Likely handler-logic calls: ${agg.totals["handler-logic"]}`
  );
  channel.appendLine(
    `  Possibly view-appropriate calls: ${agg.totals["view-possible"]}`
  );
  channel.appendLine(
    `  View-appropriate calls: ${agg.totals["view-safe"]}`
  );
  channel.appendLine("");
  channel.appendLine("Top offenders by file:");
  const top = agg.perFileCounts
    .filter(
      (p) => p.perCat["service-call"] + p.perCat["handler-logic"] > 0
    )
    .slice(0, 10);
  for (const p of top) {
    const total = p.perCat["service-call"] + p.perCat["handler-logic"];
    channel.appendLine(
      `  ${p.filePath} — ${total} calls (${p.perCat["service-call"]} service, ${p.perCat["handler-logic"]} handler logic)`
    );
  }
  channel.appendLine("");
  channel.appendLine("Most-called extraction candidates:");
  for (const t of agg.topByName.slice(0, 10)) {
    if (t.category === "view-safe") continue;
    channel.appendLine(
      `  ${t.name} — called ${t.count} times across ${t.files} files (${categoryLabel(t.category)})`
    );
  }
}

function showWebview(
  _context: vscode.ExtensionContext,
  results: FileResult[],
  agg: AggregateData,
  hasIndex: boolean
): void {
  const panel = vscode.window.createWebviewPanel(
    "cfmlRefactorExtractableWs",
    "CFML Extractable Functions — Workspace",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false }
  );
  panel.webview.html = renderHtml(results, agg, hasIndex);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.command === "open" && typeof msg.file === "string") {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const target = vscode.Uri.file(path.join(root, msg.file));
      const targetDoc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(targetDoc, { preview: false });
    } else if (msg?.command === "runFile" && typeof msg.file === "string") {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const target = vscode.Uri.file(path.join(root, msg.file));
      const targetDoc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(targetDoc, { preview: false });
      await vscode.commands.executeCommand(
        "cfml-refactor.findExtractableFunctions"
      );
    }
  });
}

function renderHtml(
  results: FileResult[],
  agg: AggregateData,
  hasIndex: boolean
): string {
  const fileRows = agg.perFileCounts
    .filter((p) => p.perCat["service-call"] + p.perCat["handler-logic"] > 0)
    .slice(0, 25)
    .map(
      (p) => `<tr>
        <td><a class="file" data-file="${escapeHtml(p.filePath)}">${escapeHtml(p.filePath)}</a></td>
        <td><span class="badge service-call">${p.perCat["service-call"]}</span></td>
        <td><span class="badge handler-logic">${p.perCat["handler-logic"]}</span></td>
        <td><span class="badge view-possible">${p.perCat["view-possible"]}</span></td>
        <td><span class="badge view-safe">${p.perCat["view-safe"]}</span></td>
      </tr>`
    )
    .join("\n");

  const topRows = agg.topByName
    .filter((t) => t.category !== "view-safe")
    .slice(0, 20)
    .map(
      (t) => `<tr>
        <td><code>${escapeHtml(t.name)}</code></td>
        <td><span class="badge ${t.category}">${escapeHtml(categoryLabel(t.category))}</span></td>
        <td>${t.count}</td>
        <td>${t.files}</td>
      </tr>`
    )
    .join("\n");

  const xref = hasIndex
    ? ""
    : `<p class="empty">Run 'Index Workspace' to enable cross-references.</p>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
  h1 { font-size: 1.1em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  h2 { font-size: 1em; margin-top: 16px; }
  .badge { display:inline-block; padding:0 6px; border-radius:3px; font-size:0.85em; margin-right:4px; }
  .service-call { background:#c0392b; color:white; }
  .handler-logic { background:#d35400; color:white; }
  .view-possible { background:#2980b9; color:white; }
  .view-safe { background:#27ae60; color:white; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  a.file { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .empty { opacity: 0.6; font-style: italic; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>
<h1>Function call extraction candidates — Workspace</h1>
<p>
  <strong>${results.length}</strong> view file${results.length === 1 ? "" : "s"} scanned.
  &nbsp;
  <span class="badge service-call">${agg.totals["service-call"]}</span> service/model
  &nbsp;
  <span class="badge handler-logic">${agg.totals["handler-logic"]}</span> handler logic
  &nbsp;
  <span class="badge view-possible">${agg.totals["view-possible"]}</span> possibly view
  &nbsp;
  <span class="badge view-safe">${agg.totals["view-safe"]}</span> view-safe
</p>
${xref}
<h2>Top offenders by file</h2>
<table>
  <thead><tr><th>File</th><th>Service</th><th>Handler</th><th>Possible</th><th>Safe</th></tr></thead>
  <tbody>${fileRows || '<tr><td colspan="5" class="empty">No flagged calls.</td></tr>'}</tbody>
</table>
<h2>Most-called extraction candidates</h2>
<table>
  <thead><tr><th>Name</th><th>Category</th><th>Calls</th><th>Files</th></tr></thead>
  <tbody>${topRows || '<tr><td colspan="4" class="empty">Nothing flagged.</td></tr>'}</tbody>
</table>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('a.file').forEach((el) => {
    el.addEventListener('click', () => {
      vscode.postMessage({ command: 'open', file: el.dataset.file });
    });
  });
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

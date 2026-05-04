import * as path from "path";
import * as vscode from "vscode";
import {
  analyzeViewCalls,
  annotateRepeatedCalls,
  type ViewCallAnalysis
} from "../analyzer/analyzeViewCalls";
import type {
  CallCategory,
  ClassifiedCall
} from "../analyzer/classifyCall";
import { ensureIndexLoaded } from "./indexWorkspace";
import type { IndexFile } from "../index/types";

const DIAGNOSTIC_SOURCE = "cfml-refactor";

let diagnostics: vscode.DiagnosticCollection | undefined;

export function registerFindExtractableFunctions(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  context.subscriptions.push(channel);

  diagnostics = vscode.languages.createDiagnosticCollection(
    "cfml-refactor.extractable"
  );
  context.subscriptions.push(diagnostics);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.findExtractableFunctions",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a file before running Find Extractable Functions."
        );
        return;
      }
      await runForEditor(editor, channel, context);
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

async function runForEditor(
  editor: vscode.TextEditor,
  channel: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<void> {
  const doc = editor.document;
  const rel = vscode.workspace
    .asRelativePath(doc.uri, false)
    .replace(/\\/g, "/");
  const cfg = readConfig();
  const analysis = analyzeViewCalls(doc.getText(), rel, cfg);
  const repeats = annotateRepeatedCalls(analysis);
  const index = await ensureIndexLoaded();

  publishDiagnostics(doc, analysis, repeats, index);
  writeChannelLog(channel, rel, analysis, repeats, index);
  channel.show(true);

  showWebview(context, doc, rel, analysis, repeats, index);
}

interface ConfigOptions {
  extraSafe: string[];
  handlerPrefixes: string[];
  servicePatterns: string[];
  viewFolderPatterns: string[];
}

export function readConfig(): ConfigOptions {
  const cfg = vscode.workspace.getConfiguration("cfml-refactor");
  return {
    extraSafe: cfg.get<string[]>("viewSafeFunctions", []),
    handlerPrefixes: cfg.get<string[]>("handlerLogicPrefixes", [
      "get",
      "fetch",
      "load",
      "find",
      "lookup",
      "calculate",
      "compute",
      "validate",
      "check",
      "is",
      "has",
      "can",
      "should",
      "process",
      "apply",
      "transform",
      "convert"
    ]),
    servicePatterns: cfg.get<string[]>("servicePatterns", [
      "Service",
      "DAO",
      "Gateway",
      "Manager",
      "Repository",
      "Model"
    ]),
    viewFolderPatterns: cfg.get<string[]>("viewFolderPatterns", [
      "**/views/**/*.cfm"
    ])
  };
}

function publishDiagnostics(
  doc: vscode.TextDocument,
  analysis: ViewCallAnalysis,
  repeats: Map<string, ClassifiedCall[]>,
  index: IndexFile | undefined
): void {
  if (!diagnostics) return;
  const diags: vscode.Diagnostic[] = [];
  for (const c of analysis.classified) {
    if (c.category === "view-safe") continue;
    const start = doc.positionAt(c.call.range.start);
    const end = doc.positionAt(c.call.range.end);
    const range = new vscode.Range(start, end);
    const severity = severityFor(c.category);
    let msg = `${categoryLabel(c.category)}: ${c.reason}`;
    if (c.suggestion) msg += `\n  Suggestion: ${c.suggestion}`;
    const sig = repeatedCallSig(c);
    const reps = repeats.get(sig);
    if (reps && reps.length > 1) {
      const lines = reps.map((r) => r.call.line).join(", ");
      msg += `\n  Repeated call (lines ${lines}) — caching candidate.`;
    }
    if (analysis.localFunctionNames.has(c.call.name.toLowerCase())) {
      msg += `\n  Function defined in same file — consider moving the function to a helper or service.`;
    }
    const xref = crossRefLine(c, index);
    if (xref) msg += `\n  ${xref}`;
    const d = new vscode.Diagnostic(range, msg, severity);
    d.source = DIAGNOSTIC_SOURCE;
    d.code = c.category;
    diags.push(d);
  }
  diagnostics.set(doc.uri, diags);
}

function repeatedCallSig(c: ClassifiedCall): string {
  const r = c.call.receiver ? `${c.call.receiver}.` : "";
  return `${r}${c.call.name}(${c.call.argsText.replace(/\s+/g, "")})`;
}

function severityFor(cat: CallCategory): vscode.DiagnosticSeverity {
  switch (cat) {
    case "service-call":
      return vscode.DiagnosticSeverity.Warning;
    case "handler-logic":
      return vscode.DiagnosticSeverity.Warning;
    case "view-possible":
      return vscode.DiagnosticSeverity.Information;
    case "view-safe":
      return vscode.DiagnosticSeverity.Hint;
  }
}

export function categoryLabel(cat: CallCategory): string {
  switch (cat) {
    case "service-call":
      return "Likely service/model call";
    case "handler-logic":
      return "Likely handler logic";
    case "view-possible":
      return "Possibly view-appropriate";
    case "view-safe":
      return "View-appropriate";
  }
}

export function crossRefLine(
  c: ClassifiedCall,
  index: IndexFile | undefined
): string | undefined {
  if (!index) return undefined;
  const fns = index.functions ?? [];
  if (fns.length === 0) return undefined;

  const lower = c.call.name.toLowerCase();
  if (c.category === "service-call" && lower === "getinstance") {
    const target = stripQuotes(c.call.args[0] ?? "");
    if (!target) return undefined;
    const componentName = target.split(".").pop();
    if (!componentName) return undefined;
    const match = findComponentDefinition(index, componentName);
    if (match) {
      return `Component "${target}" likely defined at ${match}`;
    }
    return `Component "${target}" — definition not found in workspace.`;
  }

  if (c.category === "service-call" && lower === "createobject") {
    const target = stripQuotes(c.call.args[1] ?? "");
    if (!target) return undefined;
    const componentName = target.split(".").pop();
    if (!componentName) return undefined;
    const match = findComponentDefinition(index, componentName);
    if (match) {
      return `Component "${target}" likely defined at ${match}`;
    }
    return undefined;
  }

  if (c.category === "handler-logic" || c.category === "service-call") {
    const candidates = fns.filter(
      (f) => f.name.toLowerCase() === lower && f.isPublic
    );
    if (candidates.length === 0) {
      return `Function definition not found — possibly inherited or from a framework.`;
    }
    if (candidates.length === 1) {
      return `Defined in ${candidates[0].filePath}`;
    }
    const top = candidates.slice(0, 3).map((f) => f.filePath).join(", ");
    const more =
      candidates.length > 3 ? ` (+${candidates.length - 3} more)` : "";
    return `Defined in ${candidates.length} places: ${top}${more}`;
  }
  return undefined;
}

function findComponentDefinition(
  index: IndexFile,
  componentName: string
): string | undefined {
  // Search index queries to find a CFC whose path's basename matches.
  const lc = componentName.toLowerCase();
  const allFilePaths = new Set<string>();
  for (const q of index.queries) allFilePaths.add(q.filePath);
  for (const f of index.functions ?? []) allFilePaths.add(f.filePath);
  const hit = [...allFilePaths].find((p) => {
    const base = p.split("/").pop()?.toLowerCase() ?? "";
    return base === lc + ".cfc";
  });
  return hit;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function writeChannelLog(
  channel: vscode.OutputChannel,
  rel: string,
  analysis: ViewCallAnalysis,
  repeats: Map<string, ClassifiedCall[]>,
  index: IndexFile | undefined
): void {
  channel.appendLine("");
  channel.appendLine(`=== ${rel} ===`);
  channel.appendLine(`Function call analysis:`);
  channel.appendLine(`  Total calls: ${analysis.totalCalls}`);
  channel.appendLine(
    `  Likely view-appropriate: ${analysis.counts["view-safe"]} (formatting, built-ins)`
  );
  channel.appendLine(
    `  Possibly view-appropriate: ${analysis.counts["view-possible"]}`
  );
  channel.appendLine(
    `  Likely handler logic: ${analysis.counts["handler-logic"]}`
  );
  for (const c of analysis.classified) {
    if (c.category !== "handler-logic") continue;
    const sig = repeatedCallSig(c);
    const reps = repeats.get(sig);
    if (reps && reps.length > 1 && reps[0] === c) {
      const lines = reps.map((r) => r.call.line).join(", ");
      channel.appendLine(
        `    - ${c.call.name} (line ${lines}) ← repeated, cache candidate`
      );
    } else if (!reps || reps.length === 1) {
      channel.appendLine(`    - ${c.call.name} (line ${c.call.line})`);
    }
  }
  channel.appendLine(
    `  Likely service/model: ${analysis.counts["service-call"]}`
  );
  for (const c of analysis.classified) {
    if (c.category !== "service-call") continue;
    const display = c.call.receiver
      ? `${c.call.receiver}.${c.call.name}`
      : c.call.name;
    channel.appendLine(`    - ${display} (line ${c.call.line})`);
  }

  if (index) {
    const candidates = analysis.classified.filter(
      (c) => c.category === "handler-logic" || c.category === "service-call"
    );
    let resolved = 0;
    for (const c of candidates) {
      if (crossRefLine(c, index)?.startsWith("Defined in")) resolved++;
    }
    channel.appendLine(
      `Cross-reference: ${resolved} of ${candidates.length} candidates have definitions in workspace`
    );
  } else {
    channel.appendLine(
      `Cross-reference: skipped (run 'Index Workspace' to enable cross-references).`
    );
  }
}

function showWebview(
  _context: vscode.ExtensionContext,
  doc: vscode.TextDocument,
  rel: string,
  analysis: ViewCallAnalysis,
  repeats: Map<string, ClassifiedCall[]>,
  index: IndexFile | undefined
): void {
  const panel = vscode.window.createWebviewPanel(
    "cfmlRefactorExtractable",
    `CFML Extractable Functions — ${path.basename(doc.fileName)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: false }
  );
  panel.webview.html = renderHtml(rel, analysis, repeats, index);
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

function renderHtml(
  rel: string,
  analysis: ViewCallAnalysis,
  repeats: Map<string, ClassifiedCall[]>,
  index: IndexFile | undefined
): string {
  const cats: CallCategory[] = [
    "service-call",
    "handler-logic",
    "view-possible",
    "view-safe"
  ];
  const sections = cats
    .map((cat) => {
      const items = analysis.classified.filter((c) => c.category === cat);
      return renderSection(rel, cat, items, analysis, repeats, index);
    })
    .filter((s) => s.length > 0)
    .join("\n");
  const summary = `
    <p>
      <span class="badge service-call">${analysis.counts["service-call"]}</span> service/model
      &nbsp;
      <span class="badge handler-logic">${analysis.counts["handler-logic"]}</span> handler logic
      &nbsp;
      <span class="badge view-possible">${analysis.counts["view-possible"]}</span> possibly view
      &nbsp;
      <span class="badge view-safe">${analysis.counts["view-safe"]}</span> view-safe
    </p>`;
  const xrefNotice = index
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
  .call { margin: 6px 0 8px 16px; padding: 6px; border-left: 3px solid var(--vscode-panel-border); }
  .reason { opacity: 0.85; font-size: 0.9em; }
  .suggest { margin-top: 4px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px; border-radius: 3px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
  a.file { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .empty { opacity: 0.6; font-style: italic; }
  .repeat { color: var(--vscode-editorWarning-foreground); }
  .xref { font-size: 0.85em; opacity: 0.8; margin-top: 4px; }
</style></head>
<body>
<h1>Function call extraction candidates — ${escapeHtml(rel)}</h1>
${summary}
${xrefNotice}
${sections || '<p class="empty">No function calls found.</p>'}
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
</body></html>`;
}

function renderSection(
  rel: string,
  category: CallCategory,
  items: ClassifiedCall[],
  analysis: ViewCallAnalysis,
  repeats: Map<string, ClassifiedCall[]>,
  index: IndexFile | undefined
): string {
  if (items.length === 0) return "";
  const heading = categoryLabel(category);
  const list = items
    .map((c) => renderCall(rel, c, analysis, repeats, index))
    .join("\n");
  return `<h2><span class="badge ${category}">${items.length}</span> ${escapeHtml(heading)}</h2>\n${list}`;
}

function renderCall(
  rel: string,
  c: ClassifiedCall,
  analysis: ViewCallAnalysis,
  repeats: Map<string, ClassifiedCall[]>,
  index: IndexFile | undefined
): string {
  const display = c.call.receiver
    ? `${c.call.receiver}.${c.call.name}`
    : c.call.name;
  const lines = sourceContext(analysis.source, c.call.range.start);
  const sig = repeatedCallSig(c);
  const repsList = repeats.get(sig) ?? [];
  let repeatNote = "";
  if (repsList.length > 1 && repsList[0] === c) {
    const ls = repsList.map((r) => r.call.line).join(", ");
    repeatNote = `<div class="repeat">Repeated ${repsList.length}× (lines ${ls}) — caching candidate</div>`;
  }
  let xref = "";
  if (index) {
    const x = crossRefLine(c, index);
    if (x) xref = `<div class="xref">${escapeHtml(x)}</div>`;
  }
  let localNote = "";
  if (analysis.localFunctionNames.has(c.call.name.toLowerCase())) {
    localNote = `<div class="xref">Function defined in same file — consider moving the function to a helper or service.</div>`;
  }
  return `<div class="call">
  <div>
    <a class="file" data-file="${escapeHtml(rel)}" data-start="${c.call.range.start}">
      ${escapeHtml(display)}(...) at line ${c.call.line}
    </a>
  </div>
  <div class="reason">${escapeHtml(c.reason)}</div>
  <pre>${escapeHtml(lines)}</pre>
  ${c.suggestion ? `<div class="suggest"><strong>Suggestion:</strong> ${escapeHtml(c.suggestion)}</div>` : ""}
  ${repeatNote}
  ${localNote}
  ${xref}
</div>`;
}

function sourceContext(source: string, offset: number): string {
  // Three lines: the line containing offset, plus one before and one after.
  const before = source.lastIndexOf("\n", offset - 1);
  const lineStart = before < 0 ? 0 : before + 1;
  const prevStart =
    before < 0 ? lineStart : (() => {
      const p = source.lastIndexOf("\n", before - 1);
      return p < 0 ? 0 : p + 1;
    })();
  const lineEnd = source.indexOf("\n", offset);
  const lineEndIdx = lineEnd < 0 ? source.length : lineEnd;
  const nextEnd = source.indexOf("\n", lineEndIdx + 1);
  const nextEndIdx = nextEnd < 0 ? source.length : nextEnd;
  return source.slice(prevStart, nextEndIdx);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

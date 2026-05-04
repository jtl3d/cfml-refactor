import * as vscode from "vscode";
import {
  buildFingerprintMap,
  loadIndex,
  saveIndex,
  scanWorkspace,
  updateIndexForFile
} from "../index/indexer";
import type { IndexFile, NormalizationOptions } from "../index/types";

let cachedIndex: IndexFile | undefined;
let saveDebounce: NodeJS.Timeout | undefined;

export function registerIndexWorkspace(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel("CFML Refactor");
  context.subscriptions.push(channel);

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  context.subscriptions.push(status);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.indexWorkspace",
    async () => {
      await runFullScan(channel, status);
    }
  );
  context.subscriptions.push(cmd);

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    await maybeIncrementalUpdate(doc);
  });
  context.subscriptions.push(saveListener);

  void initOnActivation(channel, status);

  return cmd;
}

async function initOnActivation(
  channel: vscode.OutputChannel,
  status: vscode.StatusBarItem
): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const cfg = vscode.workspace.getConfiguration("cfml-refactor");
  const onActivation = cfg.get<boolean>("indexOnActivation", true);
  const existing = await loadIndex(root);
  if (existing) {
    cachedIndex = existing;
    return;
  }
  if (!onActivation) return;
  await runFullScan(channel, status);
}

async function runFullScan(
  channel: vscode.OutputChannel,
  status: vscode.StatusBarItem
): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage(
      "CFML Refactor: open a folder before indexing."
    );
    return;
  }
  const cfg = vscode.workspace.getConfiguration("cfml-refactor");
  const exclude = cfg.get<string[]>(
    "indexExclude",
    ["node_modules", "dist", "build", ".git"]
  );
  const norm = readNormalizationConfig();

  status.text = "$(sync~spin) CFML Refactor: Indexing...";
  status.show();
  const result = await scanWorkspace(
    root,
    { exclude, normalization: norm },
    (p) => {
      status.text = `$(sync~spin) CFML Refactor: Indexing... ${p.scanned}/${p.total} files`;
    }
  );
  cachedIndex = result.index;
  await saveIndex(root, result.index);
  status.text = `$(database) CFML Refactor: ${result.index.queries.length} queries`;
  setTimeout(() => status.hide(), 5000);

  writeIndexLog(channel, result.fileCount, result.durationMs, result.index);
}

async function maybeIncrementalUpdate(
  doc: vscode.TextDocument
): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const fsPath = doc.uri.fsPath;
  const lower = fsPath.toLowerCase();
  if (!lower.endsWith(".cfm") && !lower.endsWith(".cfc")) return;
  if (!cachedIndex) {
    cachedIndex = await loadIndex(root);
    if (!cachedIndex) return;
  }
  const norm = readNormalizationConfig();
  cachedIndex = updateIndexForFile(
    cachedIndex,
    root,
    fsPath,
    doc.getText(),
    norm
  );
  cachedIndex.fingerprintMap = buildFingerprintMap(cachedIndex.queries);
  scheduleSave(root, cachedIndex);
}

function scheduleSave(root: string, index: IndexFile): void {
  if (saveDebounce) clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    void saveIndex(root, index);
  }, 500);
}

export function getCachedIndex(): IndexFile | undefined {
  return cachedIndex;
}

export async function ensureIndexLoaded(): Promise<IndexFile | undefined> {
  if (cachedIndex) return cachedIndex;
  const root = workspaceRoot();
  if (!root) return undefined;
  cachedIndex = await loadIndex(root);
  return cachedIndex;
}

function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

export function readNormalizationConfig(): NormalizationOptions {
  const cfg = vscode.workspace.getConfiguration("cfml-refactor");
  return {
    normalizeIdentifierCase: cfg.get<boolean>(
      "normalizeIdentifierCase",
      false
    ),
    stripTableAliases: cfg.get<boolean>("stripTableAliases", false)
  };
}

function writeIndexLog(
  channel: vscode.OutputChannel,
  fileCount: number,
  durationMs: number,
  index: IndexFile
): void {
  channel.appendLine("=== Indexing workspace ===");
  channel.appendLine(
    `Scanned ${fileCount} files in ${(durationMs / 1000).toFixed(1)}s`
  );
  channel.appendLine(`Indexed ${index.queries.length} queries`);
  const counts: Record<string, number> = {};
  for (const q of index.queries) {
    counts[q.context] = (counts[q.context] ?? 0) + 1;
  }
  for (const [ctx, n] of Object.entries(counts)) {
    channel.appendLine(`  - ${n} in ${ctx}/`);
  }
  const groups = Object.values(index.fingerprintMap);
  const dupGroups = groups.filter((ids) => ids.length > 1);
  const dupCount = dupGroups.reduce((acc, ids) => acc + ids.length, 0);
  channel.appendLine(
    `Fingerprint groups: ${groups.length} (${dupCount} duplicates across ${dupGroups.length} fingerprint groups)`
  );
}

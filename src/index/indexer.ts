import * as fs from "fs/promises";
import * as fssync from "fs";
import * as path from "path";
import { extractQueriesFromFile, inferContextFromPath } from "./extractFile";
import { extractFunctionsFromFile } from "./extractFunctions";
import {
  INDEX_VERSION,
  type IndexedFunction,
  type IndexedQuery,
  type IndexFile,
  type NormalizationOptions
} from "./types";

const INDEX_FILE_REL = path.join(".vscode", "cfml-refactor-index.json");

export interface IndexerOptions {
  exclude?: string[];
  concurrency?: number;
  normalization?: NormalizationOptions;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  currentFile?: string;
}

export interface ScanResult {
  index: IndexFile;
  durationMs: number;
  fileCount: number;
}

export async function scanWorkspace(
  workspaceRoot: string,
  opts: IndexerOptions = {},
  onProgress?: (p: ScanProgress) => void
): Promise<ScanResult> {
  const t0 = Date.now();
  const exclude = new Set(
    (opts.exclude ?? ["node_modules", "dist", "build", ".git"]).map((s) =>
      s.replace(/\\/g, "/").replace(/\/$/, "")
    )
  );
  const files = await collectFiles(workspaceRoot, exclude);
  const concurrency = opts.concurrency ?? 10;
  const queries: IndexedQuery[] = [];
  const functions: IndexedFunction[] = [];

  let scanned = 0;
  const total = files.length;
  if (onProgress) onProgress({ scanned, total });

  const queue = [...files];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, queue.length); w++) {
    workers.push(
      (async (): Promise<void> => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) return;
          try {
            const source = await fs.readFile(next, "utf8");
            const rel = toRelative(workspaceRoot, next);
            const found = extractQueriesFromFile(source, {
              filePath: rel,
              normalization: opts.normalization
            });
            for (const q of found) queries.push(q);
            if (rel.toLowerCase().endsWith(".cfc")) {
              const fns = extractFunctionsFromFile(source, {
                filePath: rel,
                context: inferContextFromPath(rel)
              });
              for (const f of fns) functions.push(f);
            }
          } catch {
            // unreadable file — skip silently
          }
          scanned++;
          if (onProgress) onProgress({ scanned, total, currentFile: next });
        }
      })()
    );
  }
  await Promise.all(workers);

  const fingerprintMap = buildFingerprintMap(queries);
  const index: IndexFile = {
    version: INDEX_VERSION,
    indexedAt: new Date().toISOString(),
    workspaceRoot,
    queries,
    fingerprintMap,
    functions
  };
  return { index, durationMs: Date.now() - t0, fileCount: total };
}

export function buildFingerprintMap(
  queries: IndexedQuery[]
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const q of queries) {
    if (!map[q.sqlFingerprint]) map[q.sqlFingerprint] = [];
    map[q.sqlFingerprint].push(q.id);
  }
  return map;
}

export function indexFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, INDEX_FILE_REL);
}

export async function saveIndex(
  workspaceRoot: string,
  index: IndexFile
): Promise<void> {
  const filePath = indexFilePath(workspaceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(index, null, 2), "utf8");
  await ensureGitignore(workspaceRoot);
}

export async function loadIndex(
  workspaceRoot: string
): Promise<IndexFile | undefined> {
  const filePath = indexFilePath(workspaceRoot);
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as IndexFile;
    if (parsed.version !== INDEX_VERSION) return undefined;
    if (!parsed.fingerprintMap) {
      parsed.fingerprintMap = buildFingerprintMap(parsed.queries);
    }
    if (!parsed.functions) parsed.functions = [];
    return parsed;
  } catch {
    return undefined;
  }
}

export function updateIndexForFile(
  index: IndexFile,
  workspaceRoot: string,
  absoluteFilePath: string,
  source: string,
  normalization?: NormalizationOptions
): IndexFile {
  const rel = toRelative(workspaceRoot, absoluteFilePath);
  const filtered = index.queries.filter((q) => q.filePath !== rel);
  const fresh = extractQueriesFromFile(source, {
    filePath: rel,
    normalization
  });
  const queries = [...filtered, ...fresh];
  let functions = index.functions;
  if (rel.toLowerCase().endsWith(".cfc")) {
    const filteredFns = (index.functions ?? []).filter(
      (f) => f.filePath !== rel
    );
    const freshFns = extractFunctionsFromFile(source, {
      filePath: rel,
      context: inferContextFromPath(rel)
    });
    functions = [...filteredFns, ...freshFns];
  }
  return {
    ...index,
    indexedAt: new Date().toISOString(),
    queries,
    fingerprintMap: buildFingerprintMap(queries),
    functions
  };
}

export function removeFileFromIndex(
  index: IndexFile,
  workspaceRoot: string,
  absoluteFilePath: string
): IndexFile {
  const rel = toRelative(workspaceRoot, absoluteFilePath);
  const queries = index.queries.filter((q) => q.filePath !== rel);
  const functions = (index.functions ?? []).filter((f) => f.filePath !== rel);
  return {
    ...index,
    indexedAt: new Date().toISOString(),
    queries,
    fingerprintMap: buildFingerprintMap(queries),
    functions
  };
}

async function collectFiles(
  root: string,
  exclude: Set<string>
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (exclude.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith(".cfm") || lower.endsWith(".cfc")) {
          out.push(full);
        }
      }
    }
  };
  await walk(root);
  return out;
}

function toRelative(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join("/");
}

async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const gi = path.join(workspaceRoot, ".gitignore");
  const target = ".vscode/cfml-refactor-index.json";
  let text = "";
  try {
    text = await fs.readFile(gi, "utf8");
  } catch {
    // missing — we'll create it
  }
  const lines = text.split(/\r?\n/);
  const has = lines.some((l) => l.trim() === target);
  if (has) return;
  const note = "# cfml-refactor: auto-generated query index";
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  const addition =
    (text.length === 0 ? "" : sep) + (text.length === 0 ? "" : "\n") +
    `${note}\n${target}\n`;
  await fs.writeFile(gi, text + addition, "utf8");
}

export function indexExistsSync(workspaceRoot: string): boolean {
  return fssync.existsSync(indexFilePath(workspaceRoot));
}

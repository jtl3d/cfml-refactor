import type {
  IndexedQuery,
  IndexFile,
  MatchType,
  QueryMatch
} from "./types";

export interface MatchOptions {
  includeTableOverlap?: boolean;
}

const CONTEXT_RANK: Record<string, number> = {
  handler: 0,
  service: 1,
  model: 2,
  view: 3,
  unknown: 4
};

const TYPE_RANK: Record<MatchType, number> = {
  EXACT: 0,
  STRUCTURAL: 1,
  "TABLE-OVERLAP": 2
};

export function findMatches(
  target: IndexedQuery,
  index: IndexFile,
  opts: MatchOptions = {}
): QueryMatch[] {
  const seen = new Set<string>([target.id]);
  const out: QueryMatch[] = [];

  const fpIds = index.fingerprintMap[target.sqlFingerprint] ?? [];
  for (const id of fpIds) {
    if (seen.has(id)) continue;
    const q = findById(index, id);
    if (!q) continue;
    seen.add(id);
    out.push({ type: "EXACT", query: q });
  }

  for (const q of index.queries) {
    if (seen.has(q.id)) continue;
    if (sameStructure(target, q)) {
      seen.add(q.id);
      out.push({ type: "STRUCTURAL", query: q });
    }
  }

  if (opts.includeTableOverlap) {
    for (const q of index.queries) {
      if (seen.has(q.id)) continue;
      if (tableOverlapMatch(target, q)) {
        seen.add(q.id);
        out.push({ type: "TABLE-OVERLAP", query: q });
      }
    }
  }

  out.sort((a, b) => {
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (t !== 0) return t;
    const c =
      (CONTEXT_RANK[a.query.context] ?? 99) -
      (CONTEXT_RANK[b.query.context] ?? 99);
    if (c !== 0) return c;
    return a.query.filePath.localeCompare(b.query.filePath);
  });

  return out;
}

function findById(index: IndexFile, id: string): IndexedQuery | undefined {
  return index.queries.find((q) => q.id === id);
}

function sameStructure(a: IndexedQuery, b: IndexedQuery): boolean {
  if (!arraysEqual(a.tables, b.tables)) return false;
  if (!arraysEqual(a.columns, b.columns)) return false;
  if (!arraysEqual(a.whereColumns, b.whereColumns)) return false;
  return true;
}

function tableOverlapMatch(a: IndexedQuery, b: IndexedQuery): boolean {
  if (a.tables.length === 0 || b.tables.length === 0) return false;
  if (a.tables[0].toLowerCase() !== b.tables[0].toLowerCase()) return false;
  const overlap = jaccardOverlap(a.columns, b.columns);
  return overlap > 0.5;
}

function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].toLowerCase() !== b[i].toLowerCase()) return false;
  }
  return true;
}

export function findMatchesForFile(
  filePath: string,
  index: IndexFile,
  opts: MatchOptions = {}
): Array<{ query: IndexedQuery; matches: QueryMatch[] }> {
  const own = index.queries.filter((q) => q.filePath === filePath);
  return own.map((q) => ({
    query: q,
    matches: findMatches(q, index, opts)
  }));
}

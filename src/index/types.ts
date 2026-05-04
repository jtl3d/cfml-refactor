export interface IndexRange {
  start: number;
  end: number;
}

export type IndexedContext =
  | "view"
  | "handler"
  | "service"
  | "model"
  | "unknown";

export type IndexedSource = "tag" | "script";

export interface IndexedQuery {
  id: string;
  filePath: string;
  range: IndexRange;
  variableName: string;
  scope: string | null;
  rawSQL: string;
  normalizedSQL: string;
  sqlFingerprint: string;
  tables: string[];
  columns: string[];
  whereColumns: string[];
  paramCount: number;
  paramTypes: string[];
  context: IndexedContext;
  isConditionalSQL: boolean;
  source: IndexedSource;
}

export interface IndexedFunction {
  name: string;
  filePath: string;
  range: IndexRange;
  argumentList: string[];
  context: IndexedContext;
  isPublic: boolean;
}

export interface IndexFile {
  version: number;
  indexedAt: string;
  workspaceRoot: string;
  queries: IndexedQuery[];
  fingerprintMap: Record<string, string[]>;
  // Optional: present for indexes built with function extraction enabled.
  // Older index files may omit this; consumers should treat as empty.
  functions?: IndexedFunction[];
}

export interface NormalizationOptions {
  normalizeIdentifierCase: boolean;
  stripTableAliases: boolean;
}

export const DEFAULT_NORMALIZATION: NormalizationOptions = {
  normalizeIdentifierCase: false,
  stripTableAliases: false
};

export type MatchType = "EXACT" | "STRUCTURAL" | "TABLE-OVERLAP";

export interface QueryMatch {
  type: MatchType;
  query: IndexedQuery;
}

export interface QueryWithMatches {
  query: IndexedQuery;
  matches: QueryMatch[];
}

// Version 2: adds optional functions[] for Phase 6 cross-reference.
export const INDEX_VERSION = 2;

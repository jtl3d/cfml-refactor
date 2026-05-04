import type { Range } from "../parser/ast";

export type LoopType =
  | "query"
  | "from-to"
  | "list"
  | "collection"
  | "condition"
  | "array"
  | "unknown";

export interface QueryContext {
  insideLoop: boolean;
  loopType?: LoopType;
  loopRange?: Range;
  loopQueryName?: string;
  insideConditional: boolean;
  insideOutput: boolean;
  insideScript: boolean;
}

export interface QueryParamInfo {
  range: Range;
  name?: string;
  cfsqltype?: string;
  value?: string;
  hasInterpolation: boolean;
}

export interface QueryInfo {
  name: string;
  range: Range;
  sqlBody: string;
  sqlBodyRange: Range;
  hasConditionalSQL: boolean;
  qparams: QueryParamInfo[];
  context: QueryContext;
  datasource?: string;
}

export interface SkippedQuery {
  range: Range;
  reason: "magic-comment" | "inside-comment" | "qoq";
  name?: string;
}

export interface AnalysisResult {
  queries: QueryInfo[];
  skipped: SkippedQuery[];
  cfscriptBlocks: number;
}

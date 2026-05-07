import type { AttributeValue, CFMLNode, Range } from "../parser/ast";

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
  rawAttributes: Map<string, AttributeValue>;
}

export interface QueryInfo {
  name: string;
  range: Range;
  sqlBody: string;
  sqlBodyRange: Range;
  hasConditionalSQL: boolean;
  hasNestedConditional: boolean;
  hasLoopInBody: boolean;
  hasSetInBody: boolean;
  qparams: QueryParamInfo[];
  context: QueryContext;
  datasource?: string;
  datasourceAttribute?: AttributeValue;
  rawAttributes: Map<string, AttributeValue>;
  bodyChildren: CFMLNode[];
  // True when the source <cfquery> had dbtype="query" (Query of Queries).
  // Surfaced so the conversion command can group these edits separately in
  // the refactor preview.
  isQoQ: boolean;
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

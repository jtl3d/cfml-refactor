import type {
  CFMLDocument,
  CFMLNode,
  Range,
  TagNode
} from "../parser/ast";
import type {
  AnalysisResult,
  LoopType,
  QueryContext,
  QueryInfo,
  QueryParamInfo,
  SkippedQuery
} from "./types";

const SKIP_COMMENT = /@cfml-refactor:skip\b/i;

interface TraversalContext {
  insideLoop: boolean;
  loopType?: LoopType;
  loopRange?: Range;
  loopQueryName?: string;
  insideConditional: boolean;
  insideOutput: boolean;
  insideScript: boolean;
}

const EMPTY_CONTEXT: TraversalContext = {
  insideLoop: false,
  insideConditional: false,
  insideOutput: false,
  insideScript: false
};

export function analyze(doc: CFMLDocument): AnalysisResult {
  const queries: QueryInfo[] = [];
  const skipped: SkippedQuery[] = [];
  let cfscriptBlocks = 0;
  let pendingSkip = false;

  const visit = (
    nodes: CFMLNode[],
    parent: TraversalContext
  ): void => {
    for (const node of nodes) {
      if (node.type === "comment") {
        if (SKIP_COMMENT.test(node.text)) {
          pendingSkip = true;
        }
        continue;
      }

      if (node.type === "content") {
        if (node.text.trim().length === 0) continue;
        continue;
      }

      if (node.type === "script") {
        cfscriptBlocks++;
        continue;
      }

      if (node.name === "cfquery") {
        if (pendingSkip) {
          skipped.push({
            range: node.range,
            reason: "magic-comment",
            name: getAttr(node, "name")
          });
          pendingSkip = false;
          continue;
        }
        // Query of Queries (dbtype="query") used to be dropped here. We now
        // emit it like any other cfquery and tag it via `isQoQ` so the
        // conversion command can group them separately in the refactor
        // preview.
        queries.push(buildQueryInfo(node, parent, doc.source));
        continue;
      }

      pendingSkip = false;

      if (node.children.length > 0) {
        const child = childContext(node, parent);
        visit(node.children, child);
      }
    }
  };

  visit(doc.children, EMPTY_CONTEXT);
  return { queries, skipped, cfscriptBlocks };
}

function childContext(
  node: TagNode,
  parent: TraversalContext
): TraversalContext {
  const ctx: TraversalContext = { ...parent };
  if (node.name === "cfloop") {
    ctx.insideLoop = true;
    ctx.loopType = classifyLoop(node);
    ctx.loopRange = node.range;
    if (ctx.loopType === "query") {
      ctx.loopQueryName = getAttr(node, "query");
    }
  } else if (node.name === "cfif") {
    ctx.insideConditional = true;
  } else if (node.name === "cfoutput") {
    ctx.insideOutput = true;
  }
  return ctx;
}

function classifyLoop(node: TagNode): LoopType {
  if (hasAttr(node, "query")) return "query";
  if (hasAttr(node, "from") || hasAttr(node, "to")) return "from-to";
  if (hasAttr(node, "list")) return "list";
  if (hasAttr(node, "collection")) return "collection";
  if (hasAttr(node, "array")) return "array";
  if (hasAttr(node, "condition")) return "condition";
  return "unknown";
}

function buildQueryInfo(
  node: TagNode,
  parent: TraversalContext,
  source: string
): QueryInfo {
  const name = getAttr(node, "name") ?? "(unnamed)";
  const datasource = getAttr(node, "datasource");
  const datasourceAttribute = node.attributes.get("datasource");
  const sqlBodyRange = computeBodyRange(node);
  const sqlBody = source.slice(sqlBodyRange.start, sqlBodyRange.end);
  const hasConditionalSQL = containsTagInBody(node, "cfif");
  const hasNestedConditional = containsNestedSameTag(node, "cfif");
  const hasLoopInBody = containsTagInBody(node, "cfloop");
  const hasSetInBody = containsTagInBody(node, "cfset");
  const qparams = collectQueryParams(node);
  const dbtype = getAttr(node, "dbtype");
  const isQoQ = dbtype !== undefined && dbtype.toLowerCase() === "query";
  const context: QueryContext = {
    insideLoop: parent.insideLoop,
    loopType: parent.loopType,
    loopRange: parent.loopRange,
    loopQueryName: parent.loopQueryName,
    insideConditional: parent.insideConditional,
    insideOutput: parent.insideOutput,
    insideScript: parent.insideScript
  };
  return {
    name,
    range: node.range,
    sqlBody,
    sqlBodyRange,
    hasConditionalSQL,
    hasNestedConditional,
    hasLoopInBody,
    hasSetInBody,
    qparams,
    context,
    datasource,
    datasourceAttribute,
    rawAttributes: node.attributes,
    bodyChildren: node.children,
    isQoQ
  };
}

function computeBodyRange(node: TagNode): Range {
  const start = node.openTagRange.end;
  const end = node.closeTagRange ? node.closeTagRange.start : node.range.end;
  return { start, end };
}

function walk(
  nodes: CFMLNode[],
  fn: (n: CFMLNode) => boolean | void
): void {
  for (const n of nodes) {
    const recurse = fn(n);
    if (recurse !== false && n.type === "tag" && n.children.length > 0) {
      walk(n.children, fn);
    }
  }
}

function containsTagInBody(node: TagNode, tagName: string): boolean {
  let found = false;
  walk(node.children, (n) => {
    if (found) return false;
    if (n.type === "tag" && n.name === tagName) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function containsNestedSameTag(node: TagNode, tagName: string): boolean {
  let nested = false;
  walk(node.children, (n) => {
    if (nested) return false;
    if (n.type === "tag" && n.name === tagName) {
      const inner = n as TagNode;
      walk(inner.children, (m) => {
        if (nested) return false;
        if (m.type === "tag" && m.name === tagName) {
          nested = true;
          return false;
        }
        return true;
      });
      return false;
    }
    return true;
  });
  return nested;
}

function collectQueryParams(node: TagNode): QueryParamInfo[] {
  const out: QueryParamInfo[] = [];
  walk(node.children, (n) => {
    if (n.type === "tag" && n.name === "cfqueryparam") {
      const tag = n as TagNode;
      const valueAttr = tag.attributes.get("value");
      out.push({
        range: n.range,
        name: getAttr(tag, "name"),
        cfsqltype: getAttr(tag, "cfsqltype"),
        value: valueAttr?.value,
        hasInterpolation: valueAttr?.hasInterpolation ?? false,
        rawAttributes: tag.attributes
      });
    }
    return true;
  });
  return out;
}

function getAttr(node: TagNode, name: string): string | undefined {
  return node.attributes.get(name)?.value;
}

function hasAttr(node: TagNode, name: string): boolean {
  return node.attributes.has(name);
}

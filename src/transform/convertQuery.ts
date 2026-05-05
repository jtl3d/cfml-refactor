import type { AttributeValue, CFMLNode, Range, TagNode } from "../parser/ast";
import type { QueryInfo, QueryParamInfo } from "../analyzer/types";
import { analyze } from "../analyzer/findQueries";
import { parse } from "../parser/parse";

const KNOWN_CFQUERY_ATTRS = new Set([
  "name",
  "datasource",
  "username",
  "password",
  "timeout",
  "result",
  "cachedwithin",
  "cachedafter",
  "maxrows",
  "blockfactor",
  "dbtype"
]);

const OPTIONS_ATTRS = [
  "datasource",
  "username",
  "password",
  "timeout",
  "result",
  "cachedwithin",
  "cachedafter",
  "maxrows",
  "blockfactor"
] as const;

const NUMERIC_OPTIONS = new Set<string>([
  "timeout",
  "cachedwithin",
  "maxrows",
  "blockfactor"
]);

const SCOPE_PREFIX_RE =
  /^(variables|local|request|session|url|form|arguments|application|server|cookie|cgi|this|super|prc|rc)\./i;

const SIMPLE_VAR_RE = /^#([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)#$/;

const COLUMN_BEFORE_RE =
  /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:=|<>|!=|<=|>=|<|>|LIKE|IS\s+NOT|IS|IN)\s*\(?\s*$/i;

export type TransformStyle = "phase2" | "ternary" | "variable-based";

export interface SkipReason {
  reason: string;
}

export interface QueryTransformation {
  range: Range;
  replacement: string;
  notes: string[];
  style: TransformStyle;
  styleReason?: string;
}

export interface SkippedItem {
  name?: string;
  range: Range;
  reason: string;
}

export interface TransformDocumentResult {
  output: string;
  transformations: QueryTransformation[];
  skipped: SkippedItem[];
}

export interface TransformOptions {
  tabUnit?: string;
  defaultDatasourcePatterns?: string[];
}

export function shouldSkipTransform(q: QueryInfo): SkipReason | undefined {
  if (q.context.insideScript) {
    return { reason: "inside <cfscript> block" };
  }
  if (q.hasNestedConditional) {
    return { reason: "nested <cfif> inside <cfif> in SQL body" };
  }
  if (q.hasLoopInBody) {
    return { reason: "<cfloop> inside <cfquery> body" };
  }
  if (q.hasSetInBody) {
    return { reason: "<cfset> inside <cfquery> body" };
  }
  for (const p of q.qparams) {
    if (p.value && p.value.includes("(")) {
      return {
        reason: `<cfqueryparam> value contains complex expression: ${p.value}`
      };
    }
  }
  for (const attr of q.rawAttributes.keys()) {
    if (!KNOWN_CFQUERY_ATTRS.has(attr)) {
      return { reason: `unknown <cfquery> attribute "${attr}"` };
    }
  }
  return undefined;
}

interface DerivedName {
  name: string;
  fromFallback: boolean;
}

export function transformQuery(
  q: QueryInfo,
  source: string,
  options: TransformOptions = {}
): QueryTransformation {
  if (q.hasConditionalSQL) {
    return transformQueryWithConditional(q, source, options);
  }
  return transformQueryPlain(q, source, options);
}

function transformQueryPlain(
  q: QueryInfo,
  source: string,
  options: TransformOptions
): QueryTransformation {
  const tabUnit = options.tabUnit ?? "    ";
  const queryIndent = indentOfPosition(source, q.range.start);
  const tab1 = queryIndent + tabUnit;
  const tab2 = queryIndent + tabUnit + tabUnit;
  const tab3 = queryIndent + tabUnit + tabUnit + tabUnit;

  const paramNames = generateParamNames(q, new Set());

  const notes: string[] = collectNotes(q.qparams, paramNames);

  const sqlReplaced = substituteParams(
    q.sqlBody,
    q.sqlBodyRange.start,
    q.qparams,
    paramNames.map((n) => n.name)
  );
  const sqlLines = formatSqlLines(sqlReplaced, tab3);

  const optionsLine = buildOptionsLine(
    q.rawAttributes,
    options.defaultDatasourcePatterns ?? []
  );
  const hasParams = q.qparams.length > 0;
  const hasOptions = optionsLine !== undefined;
  const hasMoreAfterSql = hasParams || hasOptions;

  const out: string[] = [];
  out.push(`<cfscript>`);

  for (const note of notes) {
    out.push(`${tab1}// ${note}`);
  }

  out.push(`${tab1}${makeResultName(q.name)} = queryExecute(`);

  out.push(`${tab2}"`);
  for (const line of sqlLines) out.push(line);
  out.push(`${tab2}"${hasMoreAfterSql ? "," : ""}`);

  if (hasParams) {
    out.push(`${tab2}{`);
    const paramsLines = buildParamsLines(q.qparams, paramNames, tab3);
    paramsLines.forEach((line, idx) => {
      const last = idx === paramsLines.length - 1;
      out.push(line + (last ? "" : ","));
    });
    out.push(`${tab2}}${hasOptions ? "," : ""}`);
  } else if (hasOptions) {
    out.push(`${tab2}{},`);
  }

  if (hasOptions) {
    out.push(`${tab2}${optionsLine}`);
  }

  out.push(`${tab1});`);
  out.push(`${queryIndent}</cfscript>`);

  return {
    range: q.range,
    replacement: out.join("\n"),
    notes,
    style: "phase2"
  };
}

interface BodySegment {
  kind: "text" | "param" | "cfif";
  range: Range;
  node?: CFMLNode;
}

interface CfifBranch {
  kind: "if" | "elseif" | "else";
  condition?: string;
  nodes: CFMLNode[];
  range: Range;
}

function transformQueryWithConditional(
  q: QueryInfo,
  source: string,
  options: TransformOptions
): QueryTransformation {
  const tabUnit = options.tabUnit ?? "    ";
  const queryIndent = indentOfPosition(source, q.range.start);

  const segments = collectTopLevelSegments(q);
  const cfifSegments = segments.filter((s) => s.kind === "cfif");

  // Try Style A: text-only branches across all conditionals
  const allCfifs = cfifSegments.map((s) => s.node as TagNode);
  const branchSets = allCfifs.map((node) => splitCfifBranches(node, source));

  const styleAEligible =
    cfifSegments.length > 0 &&
    branchSets.every((bs) => isStyleAEligible(bs));

  if (styleAEligible) {
    return renderStyleA(q, source, segments, branchSets, queryIndent, tabUnit, options);
  }

  return renderStyleB(q, source, segments, branchSets, queryIndent, tabUnit, options);
}

function collectTopLevelSegments(q: QueryInfo): BodySegment[] {
  const out: BodySegment[] = [];
  const bodyStart = q.sqlBodyRange.start;
  const bodyEnd = q.sqlBodyRange.end;
  let cursor = bodyStart;

  for (const child of q.bodyChildren) {
    if (child.type === "comment") continue;
    if (child.type === "content") continue;
    if (child.type === "script") continue;
    if (child.type !== "tag") continue;

    const isParam = child.name === "cfqueryparam";
    const isCfif = child.name === "cfif";
    if (!isParam && !isCfif) continue;

    if (child.range.start > cursor) {
      out.push({
        kind: "text",
        range: { start: cursor, end: child.range.start }
      });
    }
    out.push({
      kind: isParam ? "param" : "cfif",
      range: child.range,
      node: child
    });
    cursor = child.range.end;
  }

  if (cursor < bodyEnd) {
    out.push({ kind: "text", range: { start: cursor, end: bodyEnd } });
  }

  return out;
}

function splitCfifBranches(node: TagNode, source: string): CfifBranch[] {
  const branches: CfifBranch[] = [];
  const ifCondition = extractTagCondition(node, source);
  let curStart = node.openTagRange.end;
  let curKind: "if" | "elseif" | "else" = "if";
  let curCondition: string | undefined = ifCondition;
  let curNodes: CFMLNode[] = [];

  for (const child of node.children) {
    if (
      child.type === "tag" &&
      (child.name === "cfelseif" || child.name === "cfelse")
    ) {
      branches.push({
        kind: curKind,
        condition: curCondition,
        nodes: curNodes,
        range: { start: curStart, end: child.range.start }
      });
      if (child.name === "cfelseif") {
        curKind = "elseif";
        curCondition = extractTagCondition(child as TagNode, source);
      } else {
        curKind = "else";
        curCondition = undefined;
      }
      curStart = child.range.end;
      curNodes = [];
      continue;
    }
    curNodes.push(child);
  }

  const endPos = node.closeTagRange ? node.closeTagRange.start : node.range.end;
  branches.push({
    kind: curKind,
    condition: curCondition,
    nodes: curNodes,
    range: { start: curStart, end: endPos }
  });

  return branches;
}

function extractTagCondition(tag: TagNode, source: string): string {
  const raw = source.slice(tag.openTagRange.start, tag.openTagRange.end);
  const m = raw.match(/^<cf(?:if|elseif)\b\s*([\s\S]*?)\s*\/?>$/i);
  return m ? m[1].trim() : "";
}

function isStyleAEligible(branches: CfifBranch[]): boolean {
  if (branches.length < 2) return false;
  if (branches[branches.length - 1].kind !== "else") return false;
  for (const b of branches) {
    if (branchHasParam(b)) return false;
    if (branchHasOtherTag(b)) return false;
    if (extractBranchTextNormalized(b).length === 0) return false;
  }
  return true;
}

function branchHasParam(b: CfifBranch): boolean {
  for (const n of b.nodes) {
    if (n.type === "tag" && n.name === "cfqueryparam") return true;
  }
  return false;
}

function branchHasOtherTag(b: CfifBranch): boolean {
  for (const n of b.nodes) {
    if (n.type !== "tag") continue;
    if (n.name === "cfqueryparam") continue;
    return true;
  }
  return false;
}

function extractBranchTextNormalized(b: CfifBranch): string {
  let text = "";
  for (const n of b.nodes) {
    if (n.type === "content") text += n.text;
    else if (n.type === "comment") continue;
  }
  return normalizeSqlWhitespace(text);
}

function renderStyleA(
  q: QueryInfo,
  source: string,
  segments: BodySegment[],
  branchSets: CfifBranch[][],
  queryIndent: string,
  tabUnit: string,
  options: TransformOptions
): QueryTransformation {
  const tab1 = queryIndent + tabUnit;
  const tab2 = queryIndent + tabUnit + tabUnit;

  const paramNames = generateParamNames(q, new Set());
  const notes = collectNotes(q.qparams, paramNames);

  let cfifIdx = 0;
  const expressionParts: string[] = [];
  let pendingText = "";

  const flushPending = (trailingSpace: boolean): void => {
    if (pendingText.length === 0) return;
    let normalized = normalizeSqlWhitespace(pendingText);
    if (normalized.length === 0) {
      pendingText = "";
      return;
    }
    if (trailingSpace) normalized = normalized + " ";
    expressionParts.push(quote(normalized));
    pendingText = "";
  };

  for (const seg of segments) {
    if (seg.kind === "text") {
      pendingText += source.slice(seg.range.start, seg.range.end);
    } else if (seg.kind === "param") {
      const idx = q.qparams.findIndex((p) => p.range.start === seg.range.start);
      pendingText += `:${paramNames[idx].name}`;
    } else if (seg.kind === "cfif") {
      flushPending(true);
      const branches = branchSets[cfifIdx++];
      expressionParts.push(buildTernary(branches));
    }
  }
  flushPending(false);

  const optionsLine = buildOptionsLine(
    q.rawAttributes,
    options.defaultDatasourcePatterns ?? []
  );
  const hasParams = q.qparams.length > 0;
  const hasOptions = optionsLine !== undefined;

  const out: string[] = [];
  out.push(`<cfscript>`);
  for (const note of notes) out.push(`${tab1}// ${note}`);
  out.push(`${tab1}${makeResultName(q.name)} = queryExecute(`);

  for (let i = 0; i < expressionParts.length; i++) {
    const part = expressionParts[i];
    const isLastExpr = i === expressionParts.length - 1;
    const prefix = i === 0 ? "" : "& ";
    const suffix =
      isLastExpr && (hasParams || hasOptions) ? "," : "";
    out.push(`${tab2}${prefix}${part}${suffix}`);
  }

  if (hasParams) {
    const paramsObj = buildParamsInline(q.qparams, paramNames);
    out.push(`${tab2}${paramsObj}${hasOptions ? "," : ""}`);
  } else if (hasOptions) {
    out.push(`${tab2}{},`);
  }

  if (hasOptions) {
    out.push(`${tab2}${optionsLine}`);
  }

  out.push(`${tab1});`);
  out.push(`${queryIndent}</cfscript>`);

  const reason = `text-only ${branchSets.length === 1 ? "<cfif>" : "<cfif> chains"} with no <cfqueryparam>`;

  return {
    range: q.range,
    replacement: out.join("\n"),
    notes,
    style: "ternary",
    styleReason: reason
  };
}

function buildTernary(branches: CfifBranch[]): string {
  // Style A is only invoked when all branches are text-only and last is cfelse.
  // Build right-associative ternary: cond1 ? a : (cond2 ? b : c)
  const head = branches.slice(0, -1);
  const elseBranch = branches[branches.length - 1];
  let expr = quote(extractBranchTextNormalized(elseBranch));
  for (let i = head.length - 1; i >= 0; i--) {
    const b = head[i];
    const condition = b.condition ?? "true";
    const value = quote(extractBranchTextNormalized(b));
    expr = `(${condition} ? ${value} : ${expr})`;
  }
  return expr;
}

function renderStyleB(
  q: QueryInfo,
  source: string,
  segments: BodySegment[],
  branchSets: CfifBranch[][],
  queryIndent: string,
  tabUnit: string,
  options: TransformOptions
): QueryTransformation {
  const tab1 = queryIndent + tabUnit;

  const taken = new Set<string>();
  const paramNameByOffset = new Map<number, string>();

  // Pass 1: assign global names to top-level params (not inside cfif)
  for (const seg of segments) {
    if (seg.kind !== "param") continue;
    const p = findParamByRange(q.qparams, seg.range);
    if (!p) continue;
    const dn = allocateName(p, q, taken);
    paramNameByOffset.set(p.range.start, dn.name);
  }

  // Pass 2: assign names to params inside each cfif's branches.
  // Sibling branches of the same cfif are mutually exclusive at runtime, so
  // they can share names freely. Different cfif blocks can ALL execute, so
  // their param names must be globally unique. After each cfif, fold any
  // names it allocated into the global taken set.
  for (const branches of branchSets) {
    const cfifSnapshot = new Set(taken);
    const cfifGenerated = new Set<string>();
    for (const b of branches) {
      const branchTaken = new Set(cfifSnapshot);
      for (const n of b.nodes) {
        if (n.type !== "tag" || n.name !== "cfqueryparam") continue;
        const p = findParamByRange(q.qparams, n.range);
        if (!p) continue;
        const dn = allocateName(p, q, branchTaken);
        paramNameByOffset.set(p.range.start, dn.name);
        cfifGenerated.add(dn.name);
      }
    }
    for (const n of cfifGenerated) taken.add(n);
  }

  const notes: string[] = [];
  for (const p of q.qparams) {
    const name = paramNameByOffset.get(p.range.start);
    if (!name) continue;
    if (!p.cfsqltype) {
      notes.push(`TODO: cfsqltype missing for "${name}", defaulted to cf_sql_varchar`);
    }
  }

  // Build the script body.
  const lines: string[] = [];

  // Compute initial static segment text (and any base params)
  let cfifIdx = 0;
  let baseSql = "";
  const baseParamEntries: string[] = [];
  let segIdx = 0;
  for (; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    if (seg.kind === "cfif") break;
    if (seg.kind === "text") {
      baseSql += source.slice(seg.range.start, seg.range.end);
    } else if (seg.kind === "param") {
      const p = findParamByRange(q.qparams, seg.range)!;
      const name = paramNameByOffset.get(p.range.start)!;
      baseSql += `:${name}`;
      baseParamEntries.push(formatParamAssign(p, name));
    }
  }
  const baseSqlNorm = normalizeSqlWhitespace(baseSql);

  lines.push(`${tab1}var sql = ${quote(baseSqlNorm)};`);
  lines.push(`${tab1}var params = {};`);
  for (const entry of baseParamEntries) {
    lines.push(`${tab1}params.${entry};`);
  }

  // Process remaining segments: cfifs and trailing static segments
  while (segIdx < segments.length) {
    const seg = segments[segIdx];
    if (seg.kind === "cfif") {
      const branches = branchSets[cfifIdx++];
      lines.push("");
      emitConditionalBlock(
        branches,
        q,
        paramNameByOffset,
        tab1,
        tabUnit,
        lines
      );
      segIdx++;
      continue;
    }
    // Collect a contiguous run of static segments (text + param) until next cfif
    let staticSql = "";
    const staticParams: Array<{ p: QueryParamInfo; name: string }> = [];
    while (segIdx < segments.length && segments[segIdx].kind !== "cfif") {
      const s = segments[segIdx];
      if (s.kind === "text") {
        staticSql += source.slice(s.range.start, s.range.end);
      } else if (s.kind === "param") {
        const p = findParamByRange(q.qparams, s.range)!;
        const name = paramNameByOffset.get(p.range.start)!;
        staticSql += `:${name}`;
        staticParams.push({ p, name });
      }
      segIdx++;
    }
    const norm = normalizeSqlWhitespace(staticSql);
    if (norm.length > 0) {
      lines.push("");
      lines.push(`${tab1}sql &= ${quote(" " + norm)};`);
      for (const sp of staticParams) {
        lines.push(`${tab1}params.${formatParamAssign(sp.p, sp.name)};`);
      }
    } else {
      for (const sp of staticParams) {
        lines.push(`${tab1}params.${formatParamAssign(sp.p, sp.name)};`);
      }
    }
  }

  const optionsLine = buildOptionsLine(
    q.rawAttributes,
    options.defaultDatasourcePatterns ?? []
  );

  lines.push("");
  const callArgs = buildCallArgs("sql", "params", optionsLine, true);
  lines.push(`${tab1}${makeResultName(q.name)} = queryExecute(${callArgs});`);

  const out: string[] = [];
  out.push(`<cfscript>`);
  for (const note of notes) out.push(`${tab1}// ${note}`);
  for (const l of lines) out.push(l);
  out.push(`${queryIndent}</cfscript>`);

  // Compute reason
  const totalParams = countConditionalParams(branchSets);
  const reason =
    `${totalParams} <cfqueryparam> tag${totalParams === 1 ? "" : "s"} inside ` +
    `<cfif> branch${branchSets.length === 1 ? "" : "es"}`;

  return {
    range: q.range,
    replacement: out.join("\n"),
    notes,
    style: "variable-based",
    styleReason: reason
  };
}

function countConditionalParams(branchSets: CfifBranch[][]): number {
  let n = 0;
  for (const branches of branchSets) {
    for (const b of branches) {
      for (const node of b.nodes) {
        if (node.type === "tag" && node.name === "cfqueryparam") n++;
      }
    }
  }
  return n;
}

function emitConditionalBlock(
  branches: CfifBranch[],
  q: QueryInfo,
  paramNameByOffset: Map<number, string>,
  baseIndent: string,
  tabUnit: string,
  out: string[]
): void {
  const innerIndent = baseIndent + tabUnit;
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    let header: string;
    if (i === 0) header = `if (${b.condition ?? "true"}) {`;
    else if (b.kind === "elseif") header = `else if (${b.condition ?? "true"}) {`;
    else header = `else {`;

    if (i === 0) out.push(`${baseIndent}${header}`);
    else out.push(`${baseIndent}} ${header}`);

    let sqlText = "";
    const branchParams: Array<{ p: QueryParamInfo; name: string }> = [];
    for (const n of b.nodes) {
      if (n.type === "content") {
        sqlText += n.text;
      } else if (n.type === "tag" && n.name === "cfqueryparam") {
        const p = findParamByRange(q.qparams, n.range)!;
        const name = paramNameByOffset.get(p.range.start)!;
        sqlText += `:${name}`;
        branchParams.push({ p, name });
      } else if (n.type === "comment") {
        // skip
      }
    }
    const norm = normalizeSqlWhitespace(sqlText);
    if (norm.length > 0) {
      out.push(`${innerIndent}sql &= ${quote(" " + norm)};`);
    }
    for (const bp of branchParams) {
      out.push(`${innerIndent}params.${formatParamAssign(bp.p, bp.name)};`);
    }
  }
  out.push(`${baseIndent}}`);
}

function buildCallArgs(
  sqlExpr: string,
  paramsExpr: string,
  optionsLine: string | undefined,
  haveParamsVar: boolean
): string {
  if (haveParamsVar && optionsLine !== undefined) {
    return `${sqlExpr}, ${paramsExpr}, ${optionsLine}`;
  }
  if (haveParamsVar) {
    return `${sqlExpr}, ${paramsExpr}`;
  }
  if (optionsLine !== undefined) {
    return `${sqlExpr}, {}, ${optionsLine}`;
  }
  return sqlExpr;
}

function findParamByRange(
  qparams: QueryParamInfo[],
  range: Range
): QueryParamInfo | undefined {
  for (const p of qparams) {
    if (p.range.start === range.start && p.range.end === range.end) return p;
  }
  return undefined;
}

function allocateName(
  p: QueryParamInfo,
  q: QueryInfo,
  taken: Set<string>
): DerivedName {
  const derived = deriveParamName(p, q);
  if (derived === undefined) {
    let n = 1;
    let cand = `param${n}`;
    while (taken.has(cand)) {
      n++;
      cand = `param${n}`;
    }
    taken.add(cand);
    return { name: cand, fromFallback: true };
  }
  if (!taken.has(derived)) {
    taken.add(derived);
    return { name: derived, fromFallback: false };
  }
  let n = 2;
  let cand = `${derived}${n}`;
  while (taken.has(cand)) {
    n++;
    cand = `${derived}${n}`;
  }
  taken.add(cand);
  return { name: cand, fromFallback: false };
}

function formatParamAssign(p: QueryParamInfo, name: string): string {
  return `${name} = ${formatParamObject(p)}`;
}

function formatParamObject(p: QueryParamInfo): string {
  const parts: string[] = [];
  parts.push(`value: ${formatParamValue(p.value ?? "")}`);
  const cfsqltype = p.cfsqltype ?? "cf_sql_varchar";
  parts.push(`cfsqltype: ${quote(cfsqltype)}`);
  if (boolAttr(p.rawAttributes, "null")) parts.push(`null: true`);
  if (boolAttr(p.rawAttributes, "list")) {
    parts.push(`list: true`);
    const sep = p.rawAttributes.get("separator");
    if (sep) parts.push(`separator: ${quote(sep.value)}`);
  }
  const ml = p.rawAttributes.get("maxlength");
  if (ml) parts.push(`maxlength: ${ml.value}`);
  const sc = p.rawAttributes.get("scale");
  if (sc) parts.push(`scale: ${sc.value}`);
  return `{ ${parts.join(", ")} }`;
}

function buildParamsInline(
  qparams: QueryParamInfo[],
  paramNames: DerivedName[]
): string {
  if (qparams.length === 0) return "{}";
  const parts: string[] = [];
  for (let i = 0; i < qparams.length; i++) {
    parts.push(`${paramNames[i].name}: ${formatParamObject(qparams[i])}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function collectNotes(
  qparams: QueryParamInfo[],
  paramNames: DerivedName[]
): string[] {
  const notes: string[] = [];
  for (let i = 0; i < qparams.length; i++) {
    const info = paramNames[i];
    if (info.fromFallback) notes.push(`TODO: rename param "${info.name}"`);
    if (!qparams[i].cfsqltype) {
      notes.push(
        `TODO: cfsqltype missing for "${info.name}", defaulted to cf_sql_varchar`
      );
    }
  }
  return notes;
}

function normalizeSqlWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function transformDocument(
  source: string,
  options: TransformOptions = {}
): TransformDocumentResult {
  const doc = parse(source);
  const result = analyze(doc);

  const transformations: QueryTransformation[] = [];
  const skipped: SkippedItem[] = [];

  for (const q of result.queries) {
    const skip = shouldSkipTransform(q);
    if (skip) {
      skipped.push({ name: q.name, range: q.range, reason: skip.reason });
      continue;
    }
    transformations.push(transformQuery(q, source, options));
  }

  for (const s of result.skipped) {
    skipped.push({
      name: s.name,
      range: s.range,
      reason: analyzerSkipText(s.reason)
    });
  }

  let output = source;
  const sorted = [...transformations].sort(
    (a, b) => b.range.start - a.range.start
  );
  for (const t of sorted) {
    output =
      output.slice(0, t.range.start) +
      t.replacement +
      output.slice(t.range.end);
  }

  return { output, transformations, skipped };
}

function analyzerSkipText(reason: string): string {
  switch (reason) {
    case "magic-comment":
      return "skipped via @cfml-refactor:skip";
    case "qoq":
      return 'Query of Queries (dbtype="query")';
    case "inside-comment":
      return "inside CFML comment";
    default:
      return reason;
  }
}

function makeResultName(name: string): string {
  const stripped = name.replace(SCOPE_PREFIX_RE, "");
  return "prc." + stripped;
}

function indentOfPosition(source: string, pos: number): string {
  let lineStart = pos;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  let i = lineStart;
  while (i < pos) {
    const c = source[i];
    if (c === " " || c === "\t") i++;
    else break;
  }
  return source.slice(lineStart, i);
}

function substituteParams(
  body: string,
  bodyStart: number,
  qparams: QueryParamInfo[],
  paramNames: string[]
): string {
  const indexed = qparams.map((p, idx) => ({ p, idx }));
  indexed.sort((a, b) => a.p.range.start - b.p.range.start);
  let result = "";
  let cursor = 0;
  for (const { p, idx } of indexed) {
    const start = p.range.start - bodyStart;
    const end = p.range.end - bodyStart;
    result += body.slice(cursor, start);
    result += `:${paramNames[idx]}`;
    cursor = end;
  }
  result += body.slice(cursor);
  return result;
}

function formatSqlLines(rawSql: string, indent: string): string[] {
  const escaped = rawSql.replace(/"/g, '""');
  let lines = escaped.split("\n");

  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return [];

  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^[\t ]*/);
    const n = m ? m[0].length : 0;
    if (n < minIndent) minIndent = n;
  }
  if (!isFinite(minIndent)) minIndent = 0;

  return lines.map((line) => {
    if (line.trim() === "") return "";
    return indent + line.slice(minIndent);
  });
}

function generateParamNames(q: QueryInfo, taken: Set<string>): DerivedName[] {
  const result: DerivedName[] = [];
  for (const p of q.qparams) {
    result.push(allocateName(p, q, taken));
  }
  return result;
}

function deriveParamName(p: QueryParamInfo, q: QueryInfo): string | undefined {
  if (p.value) {
    const m = p.value.match(SIMPLE_VAR_RE);
    if (m) {
      const segs = m[1].split(".");
      return segs[segs.length - 1];
    }
  }
  const offsetInBody = p.range.start - q.sqlBodyRange.start;
  if (offsetInBody >= 0 && offsetInBody <= q.sqlBody.length) {
    const before = q.sqlBody.slice(0, offsetInBody);
    const colMatch = before.match(COLUMN_BEFORE_RE);
    if (colMatch) {
      const segs = colMatch[1].split(".");
      return segs[segs.length - 1];
    }
  }
  return undefined;
}

function buildParamsLines(
  qparams: QueryParamInfo[],
  paramNames: DerivedName[],
  tab3: string
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < qparams.length; i++) {
    const name = paramNames[i].name;
    lines.push(`${tab3}${name}: ${formatParamObject(qparams[i])}`);
  }
  return lines;
}

function boolAttr(attrs: Map<string, AttributeValue>, key: string): boolean {
  const a = attrs.get(key);
  if (!a) return false;
  return /^(true|yes|1)$/i.test(a.value);
}

function formatParamValue(rawValue: string): string {
  const m = rawValue.match(/^#(.+)#$/);
  if (m && !m[1].includes("#")) {
    return m[1];
  }
  return quote(rawValue);
}

function buildOptionsLine(
  attrs: Map<string, AttributeValue>,
  defaultDatasourcePatterns: string[]
): string | undefined {
  const dsAttr = attrs.get("datasource");
  const omitDatasource =
    dsAttr !== undefined && shouldOmitDatasource(dsAttr, defaultDatasourcePatterns);
  const present = OPTIONS_ATTRS.filter((a) => {
    if (a === "datasource" && omitDatasource) return false;
    return attrs.has(a);
  });
  if (present.length === 0) return undefined;
  const parts: string[] = [];
  for (const key of present) {
    const attr = attrs.get(key)!;
    const val = formatOptionValue(attr, NUMERIC_OPTIONS.has(key));
    parts.push(`${key}: ${val}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function shouldOmitDatasource(
  attr: AttributeValue,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;
  for (const pat of patterns) {
    if (pat === attr.value) return true;
  }
  return false;
}

function formatOptionValue(attr: AttributeValue, numeric: boolean): string {
  if (attr.hasInterpolation) {
    const m = attr.value.match(/^#(.+)#$/);
    if (m && !m[1].includes("#")) return m[1];
    return quote(attr.value);
  }
  if (numeric && /^-?\d+(\.\d+)?$/.test(attr.value)) {
    return attr.value;
  }
  return quote(attr.value);
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

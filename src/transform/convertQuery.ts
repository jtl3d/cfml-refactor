import type { AttributeValue, Range } from "../parser/ast";
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

export interface SkipReason {
  reason: string;
}

export interface QueryTransformation {
  range: Range;
  replacement: string;
  notes: string[];
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

export function shouldSkipTransform(q: QueryInfo): SkipReason | undefined {
  if (q.context.insideScript) {
    return { reason: "inside <cfscript> block" };
  }
  if (q.hasConditionalSQL) {
    return { reason: "SQL contains <cfif> conditional logic" };
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
  tabUnit: string
): QueryTransformation {
  const queryIndent = indentOfPosition(source, q.range.start);
  const tab1 = queryIndent + tabUnit;
  const tab2 = queryIndent + tabUnit + tabUnit;
  const tab3 = queryIndent + tabUnit + tabUnit + tabUnit;

  const paramNames = generateParamNames(q);

  const notes: string[] = [];
  for (let i = 0; i < q.qparams.length; i++) {
    const p = q.qparams[i];
    const info = paramNames[i];
    if (info.fromFallback) {
      notes.push(`TODO: rename param "${info.name}"`);
    }
    if (!p.cfsqltype) {
      notes.push(
        `TODO: cfsqltype missing for "${info.name}", defaulted to cf_sql_varchar`
      );
    }
  }

  const sqlReplaced = substituteParams(
    q,
    paramNames.map((n) => n.name)
  );
  const sqlLines = formatSqlLines(sqlReplaced, tab3);

  const optionsLine = buildOptionsLine(q.rawAttributes);
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
    notes
  };
}

export function transformDocument(
  source: string,
  tabUnit: string = "    "
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
    transformations.push(transformQuery(q, source, tabUnit));
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

function substituteParams(q: QueryInfo, paramNames: string[]): string {
  const bodyStart = q.sqlBodyRange.start;
  const indexed = q.qparams.map((p, idx) => ({ p, idx }));
  indexed.sort((a, b) => a.p.range.start - b.p.range.start);
  let result = "";
  let cursor = 0;
  for (const { p, idx } of indexed) {
    const start = p.range.start - bodyStart;
    const end = p.range.end - bodyStart;
    result += q.sqlBody.slice(cursor, start);
    result += `:${paramNames[idx]}`;
    cursor = end;
  }
  result += q.sqlBody.slice(cursor);
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

function generateParamNames(q: QueryInfo): DerivedName[] {
  const derived = q.qparams.map((p) => deriveParamName(p, q));
  const seen = new Map<string, number>();
  const result: DerivedName[] = [];
  let fallbackCounter = 0;

  for (const d of derived) {
    if (d === undefined) {
      fallbackCounter++;
      let candidate = `param${fallbackCounter}`;
      while (seen.has(candidate)) {
        fallbackCounter++;
        candidate = `param${fallbackCounter}`;
      }
      seen.set(candidate, 1);
      result.push({ name: candidate, fromFallback: true });
      continue;
    }
    const cnt = seen.get(d);
    if (cnt) {
      seen.set(d, cnt + 1);
      result.push({ name: `${d}${cnt + 1}`, fromFallback: false });
    } else {
      seen.set(d, 1);
      result.push({ name: d, fromFallback: false });
    }
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
    const p = qparams[i];
    const name = paramNames[i].name;
    const parts: string[] = [];

    parts.push(`value: ${formatParamValue(p.value ?? "")}`);

    const cfsqltype = p.cfsqltype ?? "cf_sql_varchar";
    parts.push(`cfsqltype: ${quote(cfsqltype)}`);

    if (boolAttr(p.rawAttributes, "null")) {
      parts.push(`null: true`);
    }

    if (boolAttr(p.rawAttributes, "list")) {
      parts.push(`list: true`);
      const sep = p.rawAttributes.get("separator");
      if (sep) parts.push(`separator: ${quote(sep.value)}`);
    }

    const ml = p.rawAttributes.get("maxlength");
    if (ml) parts.push(`maxlength: ${ml.value}`);

    const sc = p.rawAttributes.get("scale");
    if (sc) parts.push(`scale: ${sc.value}`);

    lines.push(`${tab3}${name}: { ${parts.join(", ")} }`);
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
  attrs: Map<string, AttributeValue>
): string | undefined {
  const present = OPTIONS_ATTRS.filter((a) => attrs.has(a));
  if (present.length === 0) return undefined;
  const parts: string[] = [];
  for (const key of present) {
    const attr = attrs.get(key)!;
    const val = formatOptionValue(attr, NUMERIC_OPTIONS.has(key));
    parts.push(`${key}: ${val}`);
  }
  return `{ ${parts.join(", ")} }`;
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

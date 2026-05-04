import * as crypto from "crypto";
import { analyze } from "../analyzer/findQueries";
import { parse } from "../parser/parse";
import type { CFMLNode } from "../parser/ast";
import { extractQueryExecuteCalls } from "./extractScript";
import { normalizeQuery } from "./normalize";
import {
  DEFAULT_NORMALIZATION,
  type IndexedContext,
  type IndexedQuery,
  type NormalizationOptions
} from "./types";

export interface ExtractOptions {
  filePath: string;
  normalization?: NormalizationOptions;
}

export function extractQueriesFromFile(
  source: string,
  opts: ExtractOptions
): IndexedQuery[] {
  const normOpts = opts.normalization ?? DEFAULT_NORMALIZATION;
  const context = inferContext(opts.filePath);
  const out: IndexedQuery[] = [];
  const doc = parse(source);
  const analysis = analyze(doc);

  for (const q of analysis.queries) {
    const norm = normalizeQuery(q.sqlBody, normOpts);
    const paramTypes = q.qparams
      .map((p) => p.cfsqltype)
      .filter((t): t is string => Boolean(t));
    const id = makeId(opts.filePath, q.range.start);
    out.push({
      id,
      filePath: opts.filePath,
      range: { start: q.range.start, end: q.range.end },
      variableName: q.name,
      scope: scopeOf(q.name),
      rawSQL: q.sqlBody,
      normalizedSQL: norm.normalizedSQL,
      sqlFingerprint: norm.fingerprint,
      tables: norm.tables,
      columns: norm.columns,
      whereColumns: norm.whereColumns,
      paramCount: q.qparams.length,
      paramTypes,
      context,
      isConditionalSQL: q.hasConditionalSQL,
      source: "tag"
    });
  }

  for (const block of collectScriptBodies(doc.children, source)) {
    const calls = extractQueryExecuteCalls(block.body, block.offset);
    for (const c of calls) {
      const norm = normalizeQuery(c.rawSQL, normOpts);
      const id = makeId(opts.filePath, c.range.start);
      out.push({
        id,
        filePath: opts.filePath,
        range: { start: c.range.start, end: c.range.end },
        variableName: c.variableName,
        scope: c.scope,
        rawSQL: c.rawSQL,
        normalizedSQL: norm.normalizedSQL,
        sqlFingerprint: norm.fingerprint,
        tables: norm.tables,
        columns: norm.columns,
        whereColumns: norm.whereColumns,
        paramCount: c.paramCount,
        paramTypes: c.paramTypes,
        context,
        isConditionalSQL: c.isConditionalSQL,
        source: "script"
      });
    }
  }

  if (isLikelyScriptOnlyCfc(opts.filePath, source, doc.children)) {
    const calls = extractQueryExecuteCalls(source, 0);
    for (const c of calls) {
      if (out.some((q) => q.range.start === c.range.start)) continue;
      const norm = normalizeQuery(c.rawSQL, normOpts);
      const id = makeId(opts.filePath, c.range.start);
      out.push({
        id,
        filePath: opts.filePath,
        range: { start: c.range.start, end: c.range.end },
        variableName: c.variableName,
        scope: c.scope,
        rawSQL: c.rawSQL,
        normalizedSQL: norm.normalizedSQL,
        sqlFingerprint: norm.fingerprint,
        tables: norm.tables,
        columns: norm.columns,
        whereColumns: norm.whereColumns,
        paramCount: c.paramCount,
        paramTypes: c.paramTypes,
        context,
        isConditionalSQL: c.isConditionalSQL,
        source: "script"
      });
    }
  }

  out.sort((a, b) => a.range.start - b.range.start);
  return out;
}

interface ScriptBlock {
  body: string;
  offset: number;
}

function collectScriptBodies(nodes: CFMLNode[], _source: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  const visit = (ns: CFMLNode[]): void => {
    for (const n of ns) {
      if (n.type === "script") {
        out.push({ body: n.body, offset: n.bodyRange.start });
        continue;
      }
      if (n.type === "tag" && n.children.length > 0) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

function isLikelyScriptOnlyCfc(
  filePath: string,
  source: string,
  topLevel: CFMLNode[]
): boolean {
  if (!filePath.toLowerCase().endsWith(".cfc")) return false;
  for (const n of topLevel) {
    if (n.type === "tag" && (n.name === "cfcomponent" || n.name === "cfscript")) {
      return false;
    }
  }
  if (/<cfcomponent\b/i.test(source)) return false;
  return /\bcomponent\b/i.test(source) || /\bqueryExecute\s*\(/i.test(source);
}

function inferContext(filePath: string): IndexedContext {
  return inferContextFromPath(filePath);
}

export function inferContextFromPath(filePath: string): IndexedContext {
  const lower = filePath.toLowerCase().replace(/\\/g, "/");
  if (/(^|\/)views?\//.test(lower)) return "view";
  if (/(^|\/)handlers?\//.test(lower)) return "handler";
  if (/(^|\/)services?\//.test(lower)) return "service";
  if (/(^|\/)(models?|entities)\//.test(lower)) return "model";
  return "unknown";
}

function scopeOf(name: string): string | null {
  const idx = name.indexOf(".");
  if (idx < 0) return null;
  return name.slice(0, idx).toLowerCase();
}

function makeId(filePath: string, start: number): string {
  return crypto
    .createHash("sha1")
    .update(`${filePath}:${start}`)
    .digest("hex")
    .slice(0, 16);
}

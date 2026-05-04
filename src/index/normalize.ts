import * as crypto from "crypto";
import {
  DEFAULT_NORMALIZATION,
  type NormalizationOptions
} from "./types";

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "like", "between",
  "is", "null", "order", "by", "group", "having", "asc", "desc", "distinct",
  "all", "union", "intersect", "except", "join", "inner", "outer", "left",
  "right", "full", "cross", "on", "using", "as", "with", "case", "when",
  "then", "else", "end", "exists", "any", "some", "limit", "offset", "top",
  "into", "values", "set", "update", "insert", "delete", "create", "drop",
  "table", "view", "index", "primary", "key", "foreign", "references",
  "default", "check", "constraint", "unique", "true", "false"
]);

const CLAUSE_TERMINATORS = new Set([
  "where", "group", "order", "having", "limit", "offset", "union",
  "intersect", "except", "on", "join", "inner", "left", "right", "outer",
  "cross", "full", "into", "set", "values", "for"
]);

const COMPARISON_OPS = new Set([
  "=", "<>", "!=", "<=", ">=", "<", ">"
]);

export interface NormalizedQuery {
  normalizedSQL: string;
  fingerprint: string;
  tables: string[];
  columns: string[];
  whereColumns: string[];
}

export function normalizeQuery(
  rawSQL: string,
  opts: NormalizationOptions = DEFAULT_NORMALIZATION
): NormalizedQuery {
  let sql = rawSQL;

  sql = stripCfmlComments(sql);
  sql = stripCfqueryparamTags(sql);
  sql = stripSqlComments(sql);
  sql = replaceStringLiterals(sql);
  sql = replaceParamPlaceholders(sql);
  sql = replaceNumericLiterals(sql);
  sql = lowercaseKeywords(sql, opts.normalizeIdentifierCase);
  sql = collapseWhitespace(sql).trim();
  sql = stripTrailingSemicolon(sql);

  if (opts.stripTableAliases) {
    sql = stripAliases(sql);
  }

  const tables = extractTables(sql);
  const columns = extractSelectColumns(sql);
  const whereColumns = extractWhereColumns(sql);

  const fingerprint = sha1(sql);

  return {
    normalizedSQL: sql,
    fingerprint,
    tables,
    columns,
    whereColumns
  };
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function stripCfmlComments(sql: string): string {
  return sql.replace(/<!---[\s\S]*?--->/g, " ");
}

function stripSqlComments(sql: string): string {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = out.replace(/--[^\n]*/g, " ");
  return out;
}

function stripCfqueryparamTags(sql: string): string {
  return sql.replace(/<cfqueryparam\b[^>]*\/?\s*>/gi, "?");
}

function replaceStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += "?";
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += "?";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function replaceParamPlaceholders(sql: string): string {
  let out = sql.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "?");
  out = out.replace(/\?\?+/g, "?");
  return out;
}

function replaceNumericLiterals(sql: string): string {
  return sql.replace(/(?<![A-Za-z_0-9.])-?\d+(?:\.\d+)?(?![A-Za-z_0-9.])/g, "?");
}

function lowercaseKeywords(sql: string, lowerAll: boolean): string {
  return sql.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
    const lower = word.toLowerCase();
    if (SQL_KEYWORDS.has(lower)) return lower;
    if (lowerAll) return lower;
    return word;
  });
}

function collapseWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ");
}

function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;+\s*$/, "").trimEnd();
}

function stripAliases(sql: string): string {
  let out = sql;
  out = out.replace(
    /\b(from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]{0,2})(?=\s|,|$)/gi,
    (_m, kw: string, table: string, alias: string) => {
      const lowAlias = alias.toLowerCase();
      if (SQL_KEYWORDS.has(lowAlias) || CLAUSE_TERMINATORS.has(lowAlias)) {
        return `${kw} ${table} ${alias}`;
      }
      return `${kw} ${table}`;
    }
  );
  return out;
}

interface Token {
  text: string;
  start: number;
  end: number;
  isWord: boolean;
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_.]/.test(sql[i])) i++;
      tokens.push({ text: sql.slice(start, i), start, end: i, isWord: true });
      continue;
    }
    if (sql[i] === "<" && sql[i + 1] === ">") {
      tokens.push({ text: "<>", start: i, end: i + 2, isWord: false });
      i += 2; continue;
    }
    if ((sql[i] === "<" || sql[i] === ">" || sql[i] === "!") && sql[i + 1] === "=") {
      tokens.push({ text: sql.slice(i, i + 2), start: i, end: i + 2, isWord: false });
      i += 2; continue;
    }
    tokens.push({ text: ch, start: i, end: i + 1, isWord: false });
    i++;
  }
  return tokens;
}

function extractTables(sql: string): string[] {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.isWord && (t.text.toLowerCase() === "from" || t.text.toLowerCase() === "join")) {
      i++;
      while (i < tokens.length) {
        const n = tokens[i];
        if (n.isWord) {
          const lower = n.text.toLowerCase();
          if (CLAUSE_TERMINATORS.has(lower) || SQL_KEYWORDS.has(lower)) break;
          if (lower === "as") {
            i++;
            if (i < tokens.length) i++;
            continue;
          }
          out.push(stripQuotes(n.text));
          i++;
          if (i < tokens.length && tokens[i].text === ",") { i++; continue; }
          if (i < tokens.length && tokens[i].isWord) {
            const aliasLower = tokens[i].text.toLowerCase();
            if (
              !SQL_KEYWORDS.has(aliasLower) &&
              !CLAUSE_TERMINATORS.has(aliasLower)
            ) {
              i++;
              if (i < tokens.length && tokens[i].text === ",") { i++; continue; }
            }
          }
          continue;
        }
        if (n.text === "(") {
          let depth = 1;
          i++;
          while (i < tokens.length && depth > 0) {
            if (tokens[i].text === "(") depth++;
            else if (tokens[i].text === ")") depth--;
            i++;
          }
          continue;
        }
        break;
      }
      continue;
    }
    i++;
  }
  return dedupSorted(out);
}

function extractSelectColumns(sql: string): string[] {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.isWord && t.text.toLowerCase() === "select") {
      i++;
      if (i < tokens.length && tokens[i].isWord && tokens[i].text.toLowerCase() === "distinct") i++;
      const items: Token[][] = [];
      let cur: Token[] = [];
      let depth = 0;
      while (i < tokens.length) {
        const n = tokens[i];
        if (n.isWord && n.text.toLowerCase() === "from" && depth === 0) {
          if (cur.length > 0) items.push(cur);
          break;
        }
        if (n.text === "(") { depth++; cur.push(n); i++; continue; }
        if (n.text === ")") { depth--; cur.push(n); i++; continue; }
        if (n.text === "," && depth === 0) {
          if (cur.length > 0) items.push(cur);
          cur = [];
          i++;
          continue;
        }
        cur.push(n);
        i++;
      }
      for (const item of items) {
        const col = parseSelectItem(item);
        if (col) out.push(col);
      }
      break;
    }
    i++;
  }
  return out;
}

function parseSelectItem(tokens: Token[]): string | null {
  if (tokens.length === 0) return null;
  let end = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.isWord && t.text.toLowerCase() === "as") {
      end = i;
      break;
    }
  }
  if (end === tokens.length && tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    if (last.isWord && prev.isWord && prev.text !== "." && !isFunctionTail(tokens, tokens.length - 2)) {
      const lower = last.text.toLowerCase();
      if (!SQL_KEYWORDS.has(lower)) {
        end = tokens.length - 1;
      }
    }
  }
  const head = tokens.slice(0, end);
  return formatColumn(head);
}

function isFunctionTail(_tokens: Token[], _idx: number): boolean {
  return false;
}

function formatColumn(tokens: Token[]): string | null {
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0].text === "*") return "*";
  if (tokens.length === 1 && tokens[0].isWord) {
    return stripPrefix(tokens[0].text);
  }
  const text = tokens.map((t) => t.text).join("");
  const fnMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (fnMatch) {
    const fn = fnMatch[1].toLowerCase();
    const arg = fnMatch[2].trim();
    const argClean = arg === "*" ? "*" : stripPrefix(arg);
    return `${fn}_${argClean}`;
  }
  return stripPrefix(text);
}

function stripPrefix(name: string): string {
  const trimmed = stripQuotes(name);
  const idx = trimmed.lastIndexOf(".");
  if (idx >= 0) return trimmed.slice(idx + 1);
  return trimmed;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "`" && last === "`") || (first === '"' && last === '"') || (first === "[" && last === "]")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function extractWhereColumns(sql: string): string[] {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let i = 0;
  let inWhere = false;
  let depth = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.isWord) {
      const lower = t.text.toLowerCase();
      if (lower === "where") { inWhere = true; i++; continue; }
      if (inWhere && depth === 0 && (lower === "group" || lower === "order" || lower === "having" || lower === "limit" || lower === "union" || lower === "intersect" || lower === "except")) {
        inWhere = false;
      }
    }
    if (inWhere) {
      if (t.text === "(") { depth++; i++; continue; }
      if (t.text === ")") { depth--; i++; continue; }
      if (t.isWord) {
        const lower = t.text.toLowerCase();
        if (SQL_KEYWORDS.has(lower)) { i++; continue; }
        const next = nextNonWs(tokens, i + 1);
        if (next !== -1) {
          const nxt = tokens[next];
          if (
            COMPARISON_OPS.has(nxt.text) ||
            (nxt.isWord && (nxt.text.toLowerCase() === "in" || nxt.text.toLowerCase() === "like" || nxt.text.toLowerCase() === "between" || nxt.text.toLowerCase() === "is"))
          ) {
            out.push(stripPrefix(t.text));
            i = next + 1;
            continue;
          }
        }
      }
    }
    i++;
  }
  return dedupSorted(out);
}

function nextNonWs(tokens: Token[], start: number): number {
  if (start >= tokens.length) return -1;
  return start;
}

function dedupSorted(arr: string[]): string[] {
  return Array.from(new Set(arr)).sort();
}

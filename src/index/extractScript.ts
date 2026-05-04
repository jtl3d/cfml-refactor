import type { IndexRange } from "./types";

export interface ScriptQueryExtraction {
  variableName: string;
  scope: string | null;
  rawSQL: string;
  paramTypes: string[];
  paramCount: number;
  isConditionalSQL: boolean;
  range: IndexRange;
}

export function extractQueryExecuteCalls(
  body: string,
  baseOffset: number
): ScriptQueryExtraction[] {
  if (!body.includes("queryExecute") && !body.includes("queryexecute")) {
    return [];
  }
  const out: ScriptQueryExtraction[] = [];
  let i = 0;
  const len = body.length;
  while (i < len) {
    const ch = body[i];
    if (ch === "/" && body[i + 1] === "/") {
      while (i < len && body[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < len && !(body[i] === "*" && body[i + 1] === "/")) i++;
      if (i < len) i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(body, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const stmtStart = i;
      const idStart = i;
      while (i < len && /[A-Za-z0-9_.]/.test(body[i])) i++;
      const ident = body.slice(idStart, i);
      let j = skipSpaces(body, i);
      if (body[j] === "=" && body[j + 1] !== "=") {
        const afterEq = skipSpaces(body, j + 1);
        const KW = "queryexecute";
        if (body.slice(afterEq, afterEq + KW.length).toLowerCase() === KW) {
          const callStart = afterEq + KW.length;
          const parenAt = skipSpaces(body, callStart);
          if (body[parenAt] === "(") {
            const parsed = parseQueryExecuteCall(body, parenAt);
            if (parsed) {
              const end = parsed.end;
              const paramInfo = extractParamTypes(parsed.argsText);
              out.push({
                variableName: ident,
                scope: scopeOf(ident),
                rawSQL: parsed.sqlText,
                paramTypes: paramInfo.types,
                paramCount: paramInfo.count,
                isConditionalSQL: false,
                range: {
                  start: baseOffset + stmtStart,
                  end: baseOffset + end
                }
              });
              i = end;
              continue;
            }
          }
        }
      }
      continue;
    }
    i++;
  }
  return out;
}

interface ParsedCall {
  sqlText: string;
  argsText: string;
  end: number;
}

function parseQueryExecuteCall(body: string, parenAt: number): ParsedCall | null {
  let i = parenAt + 1;
  i = skipSpacesAndComments(body, i);
  let sqlText: string | null = null;

  if (body[i] === '"' || body[i] === "'") {
    const parsed = readStringLiteral(body, i);
    if (!parsed) return null;
    sqlText = parsed.value;
    i = parsed.end;
    while (true) {
      const after = skipSpacesAndComments(body, i);
      if (body[after] === "&") {
        const next = skipSpacesAndComments(body, after + 1);
        if (body[next] === '"' || body[next] === "'") {
          const more = readStringLiteral(body, next);
          if (!more) break;
          sqlText += more.value;
          i = more.end;
          continue;
        }
      }
      break;
    }
  } else {
    return null;
  }

  i = skipSpacesAndComments(body, i);
  const argsTextStart = i;
  let depth = 1;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      i = skipString(body, i);
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i++;
      if (i < body.length) i += 2;
      continue;
    }
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { depth--; i++; continue; }
    i++;
  }
  const argsTextEnd = i - 1;
  const argsText = body.slice(argsTextStart, argsTextEnd);
  let end = i;
  while (end < body.length && /[ \t]/.test(body[end])) end++;
  if (body[end] === ";") end++;

  return { sqlText, argsText, end };
}

interface StringRead {
  value: string;
  end: number;
}

function readStringLiteral(body: string, i: number): StringRead | null {
  const quote = body[i];
  if (quote !== '"' && quote !== "'") return null;
  i++;
  let out = "";
  while (i < body.length) {
    const ch = body[i];
    if (ch === quote) {
      if (body[i + 1] === quote) {
        out += quote;
        i += 2;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    if (ch === "#") {
      const closeIdx = body.indexOf("#", i + 1);
      if (closeIdx === -1) return { value: out, end: body.length };
      out += body.slice(i, closeIdx + 1);
      i = closeIdx + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { value: out, end: body.length };
}

function skipSpaces(body: string, i: number): number {
  while (i < body.length && /[ \t\r\n]/.test(body[i])) i++;
  return i;
}

function skipSpacesAndComments(body: string, i: number): number {
  while (i < body.length) {
    if (/[ \t\r\n]/.test(body[i])) { i++; continue; }
    if (body[i] === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (body[i] === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i++;
      if (i < body.length) i += 2;
      continue;
    }
    break;
  }
  return i;
}

function skipString(body: string, i: number): number {
  const quote = body[i];
  i++;
  while (i < body.length) {
    if (body[i] === quote) {
      if (body[i + 1] === quote) { i += 2; continue; }
      return i + 1;
    }
    if (body[i] === "#") {
      const closeIdx = body.indexOf("#", i + 1);
      if (closeIdx === -1) return body.length;
      i = closeIdx + 1;
      continue;
    }
    i++;
  }
  return i;
}

function scopeOf(name: string): string | null {
  const idx = name.indexOf(".");
  if (idx < 0) return null;
  return name.slice(0, idx).toLowerCase();
}

interface ParamInfo {
  types: string[];
  count: number;
}

function extractParamTypes(argsText: string): ParamInfo {
  const types: string[] = [];
  const re = /cfsqltype\s*[:=]\s*"([^"]+)"|cfsqltype\s*[:=]\s*'([^']+)'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsText)) !== null) {
    types.push(m[1] ?? m[2]);
  }
  let count = types.length;
  if (count === 0) {
    const namedRe = /\{\s*value\s*[:=]/gi;
    while (namedRe.exec(argsText) !== null) count++;
  }
  return { types, count };
}

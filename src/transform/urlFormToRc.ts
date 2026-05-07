export interface UrlFormRewriteResult {
  output: string;
  urlRewrites: number;
  formRewrites: number;
  collisions: Array<{ key: string; functionName: string }>;
  skippedFunctions: Array<{ name: string; reason: string }>;
}

interface FunctionInfo {
  name: string;
  bodyStart: number;
  bodyEnd: number;
  hasRcArg: boolean;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
  scope: "url" | "form";
  key: string;
  functionIndex: number;
}

export function rewriteUrlFormToRc(source: string): UrlFormRewriteResult {
  const functions = findFunctions(source);
  const skipped: UrlFormRewriteResult["skippedFunctions"] = [];
  const stringRanges = findStringAndCommentRanges(source);

  const edits: Edit[] = [];
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    if (!fn.hasRcArg) {
      skipped.push({
        name: fn.name,
        reason: "function does not have an rc argument"
      });
      continue;
    }
    const fnEdits = collectScopeRewrites(
      source,
      fn.bodyStart,
      fn.bodyEnd,
      stringRanges,
      i
    );
    for (const e of fnEdits) edits.push(e);
  }

  const keysByFn = new Map<number, Map<string, Set<"url" | "form">>>();
  for (const e of edits) {
    let m = keysByFn.get(e.functionIndex);
    if (!m) {
      m = new Map();
      keysByFn.set(e.functionIndex, m);
    }
    let s = m.get(e.key);
    if (!s) {
      s = new Set();
      m.set(e.key, s);
    }
    s.add(e.scope);
  }
  const collisions: UrlFormRewriteResult["collisions"] = [];
  for (const [fnIdx, m] of keysByFn) {
    for (const [key, scopes] of m) {
      if (scopes.size > 1) {
        collisions.push({ key, functionName: functions[fnIdx].name });
      }
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let output = source;
  let urlRewrites = 0;
  let formRewrites = 0;
  for (const e of edits) {
    output =
      output.slice(0, e.start) + e.replacement + output.slice(e.end);
    if (e.scope === "url") urlRewrites++;
    else formRewrites++;
  }

  return {
    output,
    urlRewrites,
    formRewrites,
    collisions,
    skippedFunctions: skipped
  };
}

function findFunctions(source: string): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const re = /\bfunction\s+([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchParen(source, parenStart);
    if (parenEnd === -1) continue;
    const argList = source.slice(parenStart + 1, parenEnd);
    const hasRcArg = checkRcArg(argList);
    let bracePos = parenEnd + 1;
    while (bracePos < source.length && source[bracePos] !== "{") {
      if (source[bracePos] === ";" || source[bracePos] === "}") break;
      bracePos++;
    }
    if (bracePos >= source.length || source[bracePos] !== "{") continue;
    const braceEnd = matchBrace(source, bracePos);
    if (braceEnd === -1) continue;
    out.push({
      name,
      bodyStart: bracePos + 1,
      bodyEnd: braceEnd,
      hasRcArg
    });
  }
  return out;
}

function checkRcArg(argList: string): boolean {
  const re = /(?:^|,)\s*(?:required\s+)?(?:[A-Za-z_]\w*\s+)?rc\b/i;
  return re.test(argList);
}

interface Range {
  start: number;
  end: number;
}

function findStringAndCommentRanges(source: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i++;
      out.push({ start, end: i });
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      if (i < source.length) i += 2;
      out.push({ start, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const q = c;
      i++;
      while (i < source.length) {
        if (source[i] === q) {
          if (source[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push({ start, end: i });
      continue;
    }
    i++;
  }
  return out;
}

function inRanges(pos: number, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (pos >= r.start && pos < r.end) return true;
  }
  return false;
}

function collectScopeRewrites(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  stringRanges: Range[],
  fnIdx: number
): Edit[] {
  const out: Edit[] = [];
  const dotRe = /(?<![.\w])(url|form)\.([A-Za-z_]\w*)/gi;
  const bracketRe =
    /(?<![.\w])(url|form)\s*\[\s*("([^"]*)"|'([^']*)')\s*\]/gi;

  dotRe.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = dotRe.exec(source)) !== null) {
    if (m.index >= bodyEnd) break;
    if (inRanges(m.index, stringRanges)) continue;
    const scope = m[1].toLowerCase() as "url" | "form";
    const key = m[2];
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: `rc.${key}`,
      scope,
      key,
      functionIndex: fnIdx
    });
  }

  bracketRe.lastIndex = bodyStart;
  while ((m = bracketRe.exec(source)) !== null) {
    if (m.index >= bodyEnd) break;
    if (inRanges(m.index, stringRanges)) continue;
    const scope = m[1].toLowerCase() as "url" | "form";
    const key = m[3] ?? m[4];
    const quote = m[2].startsWith('"') ? '"' : "'";
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: `rc[ ${quote}${key}${quote} ]`,
      scope,
      key,
      functionIndex: fnIdx
    });
  }

  return out;
}

function matchParen(source: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      i = skipString(source, i, c);
    }
  }
  return -1;
}

function matchBrace(source: string, openPos: number): number {
  let depth = 0;
  for (let i = openPos; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      i = skipString(source, i, c);
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      if (i < source.length) i++;
    }
  }
  return -1;
}

function skipString(source: string, openPos: number, quote: string): number {
  let i = openPos + 1;
  while (i < source.length) {
    if (source[i] === quote) {
      if (source[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return source.length - 1;
}

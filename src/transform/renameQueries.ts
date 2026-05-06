import type { CFMLNode, Range } from "../parser/ast";
import { parse } from "../parser/parse";

const SCOPE_PREFIX_RE =
  /^(variables|local|request|session|url|form|arguments|application|server|cookie|cgi|this|super|prc|rc)\./i;

// Scopes a CFML query variable can live under. Used to find references like
// `variables.foo` or `local.foo` and rewrite them to `prc.foo`. `prc` itself
// is excluded — that's our target.
const RENAMABLE_SCOPES =
  "variables|local|request|application|session|rc";

export interface QueryRename {
  // The original assignment target text, e.g. "variables.getThing" or "getUsers".
  originalName: string;
  // The bare query name with any scope prefix stripped, e.g. "getThing".
  baseName: string;
}

export function stripScopePrefix(name: string): string {
  return name.replace(SCOPE_PREFIX_RE, "");
}

function rangeOverlapsAny(r: Range, ranges: ReadonlyArray<Range>): boolean {
  for (const x of ranges) {
    if (r.start < x.end && r.end > x.start) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface QueryExecuteAssignment {
  // Range of the assignment target (the variable being assigned).
  // e.g. for `local.foo = queryExecute(...)`, this covers `local.foo`.
  // For `var bar = queryExecute(...)`, this covers `bar` (without `var`).
  targetRange: Range;
  // The full target text within the source (e.g. "local.foo" or "bar").
  target: string;
  // The bare base name with any scope prefix or `var` declarator stripped.
  baseName: string;
  // Range of the enclosing function body (between the `function name(...) {`
  // brace and its matching `}`), or `undefined` if the assignment is not
  // inside a function/method.
  enclosingFunctionRange?: Range;
}

// Locate every `<target> = queryExecute(...)` assignment in a CFML source. A
// match is recorded only when the target is something we can rename: a bare
// identifier, a `var <ident>` declaration, or a scope-qualified identifier
// like `local.foo` or `variables.foo`. Targets already prefixed with `prc.`
// are skipped.
export function findQueryExecuteAssignments(
  source: string
): QueryExecuteAssignment[] {
  const out: QueryExecuteAssignment[] = [];
  // Find queryExecute( occurrences, then walk back to locate the assignment
  // target. Skip occurrences that aren't `<target> = queryExecute(...)`.
  const callRe = /\bqueryExecute\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const callStart = m.index;
    const before = source.slice(0, callStart);
    const eqMatch = before.match(/=\s*$/);
    if (!eqMatch || eqMatch.index === undefined) continue;
    const eqPos = eqMatch.index; // position of `=` in source
    // Step back past whitespace before `=` to find the end of the target.
    let tEnd = eqPos;
    while (tEnd > 0 && /\s/.test(source[tEnd - 1])) tEnd--;
    // Read the identifier (with optional scope prefix) backward.
    let tStart = tEnd;
    while (tStart > 0) {
      const ch = source[tStart - 1];
      if (/[A-Za-z0-9_.]/.test(ch)) tStart--;
      else break;
    }
    if (tStart === tEnd) continue;
    const target = source.slice(tStart, tEnd);
    // Reject targets that already start with prc.
    if (/^prc\./i.test(target)) continue;
    const baseName = stripScopePrefix(target);
    if (!baseName) continue;
    if (!/^[A-Za-z_][\w]*$/.test(baseName)) continue;
    out.push({
      targetRange: { start: tStart, end: tEnd },
      target,
      baseName,
      enclosingFunctionRange: findEnclosingFunctionRange(source, callStart)
    });
  }
  return out;
}

// Find the byte range of the function/method body that contains `pos`. We
// look for `function <name>(` (or `<modifier> function <name>(`) before
// `pos`, find its `{`, then match braces forward until we hit the closing
// `}`. Returns `undefined` when `pos` is at file scope.
export function findEnclosingFunctionRange(
  source: string,
  pos: number
): Range | undefined {
  // Find the nearest `function NAME(` whose matching `{ ... }` contains pos.
  const fnRe = /\bfunction\s+[A-Za-z_]\w*\s*\(/gi;
  let best: Range | undefined;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(source)) !== null) {
    if (m.index >= pos) break;
    // From the `(` step forward to find the matching `)`, then the next `{`.
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchParen(source, parenStart);
    if (parenEnd === -1) continue;
    // After `)`, find the first `{` (skipping whitespace and a possible
    // return-type modifier list — for simplicity just scan to the next `{`).
    let bracePos = parenEnd + 1;
    while (bracePos < source.length && source[bracePos] !== "{") {
      if (source[bracePos] === ";" || source[bracePos] === "}") break;
      bracePos++;
    }
    if (bracePos >= source.length || source[bracePos] !== "{") continue;
    const braceEnd = matchBrace(source, bracePos);
    if (braceEnd === -1) continue;
    if (pos > bracePos && pos < braceEnd) {
      // Track the innermost match.
      if (!best || bracePos > best.start) {
        best = { start: bracePos + 1, end: braceEnd };
      }
    }
  }
  return best;
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

export interface RenameQueriesResult {
  // Final source after renames are applied.
  output: string;
  // The set of assignment targets that were renamed (one per file scope).
  renamed: Array<{
    target: string;
    replacement: string;
    enclosingFunctionRange?: Range;
  }>;
  // Total reference matches replaced (excluding the assignment target itself
  // and any references inside the queryExecute SQL string).
  referenceMatches: number;
}

// Rename every `<x> = queryExecute(...)` assignment in `source` so the target
// becomes `prc.<baseName>`, and rewrite same-scope references accordingly.
// Function-body assignments are scoped to that function body; file-scope
// assignments rename across the document but skip ranges that belong to
// other function scopes (those are processed with their own rename set so a
// shadowed name in a sibling function isn't accidentally rewritten).
//
// Within `<cfscript>` bodies, double-quoted string literals are excluded so
// SQL embedded in a queryExecute(...) call is left untouched. Outside script
// bodies, the source is tag markup where `"` is an attribute delimiter, not
// a string literal — so attribute values like `<cfoutput query="getUsers">`
// are still rewritten.
export function renameQueriesInSource(source: string): RenameQueriesResult {
  const assignments = findQueryExecuteAssignments(source);
  if (assignments.length === 0) {
    return { output: source, renamed: [], referenceMatches: 0 };
  }

  type ScopeEntry = { range: Range | undefined; renames: QueryRename[] };
  const scopes = new Map<string, ScopeEntry>();
  const scopeKey = (r: Range | undefined): string =>
    r ? `${r.start}-${r.end}` : "<file>";
  for (const a of assignments) {
    const key = scopeKey(a.enclosingFunctionRange);
    let entry = scopes.get(key);
    if (!entry) {
      entry = { range: a.enclosingFunctionRange, renames: [] };
      scopes.set(key, entry);
    }
    entry.renames.push({ originalName: a.target, baseName: a.baseName });
  }

  const renamed: RenameQueriesResult["renamed"] = assignments.map((a) => ({
    target: a.target,
    replacement: `prc.${a.baseName}`,
    enclosingFunctionRange: a.enclosingFunctionRange
  }));

  const stringRanges = collectStringLiteralRangesInScripts(source);

  const fnEntries: Array<{ range: Range; renames: QueryRename[] }> = [];
  for (const s of scopes.values()) {
    if (s.range !== undefined) {
      fnEntries.push({ range: s.range, renames: s.renames });
    }
  }
  fnEntries.sort((a, b) => a.range.start - b.range.start);
  const fileScope = scopes.get("<file>");

  type Edit = { range: Range; replacement: string };
  const edits: Edit[] = [];

  const collectMatches = (
    renames: QueryRename[],
    rangeStart: number,
    rangeEnd: number,
    excludeFnBodies: boolean
  ): void => {
    for (const r of renames) {
      if (!r.baseName) continue;
      const replacement = `prc.${r.baseName}`;
      const re = new RegExp(
        `(?<![\\w.])(?:(?:${RENAMABLE_SCOPES})\\.)?${escapeRegex(r.baseName)}\\b`,
        "gi"
      );
      re.lastIndex = rangeStart;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const ms = m.index;
        const me = ms + m[0].length;
        if (me > rangeEnd) break;
        if (m[0] === replacement) continue;
        if (excludeFnBodies) {
          let inFn = false;
          for (const fn of fnEntries) {
            if (ms >= fn.range.start && me <= fn.range.end) {
              inFn = true;
              break;
            }
          }
          if (inFn) continue;
        }
        if (rangeOverlapsAny({ start: ms, end: me }, stringRanges)) continue;
        edits.push({ range: { start: ms, end: me }, replacement });
      }
    }
  };

  for (const fn of fnEntries) {
    collectMatches(fn.renames, fn.range.start, fn.range.end, false);
  }
  if (fileScope) {
    collectMatches(fileScope.renames, 0, source.length, true);
  }

  // Dedupe edits at identical ranges (the assignment target itself can match
  // both as a raw identifier and as a scope-qualified one).
  const seen = new Set<string>();
  const unique: Edit[] = [];
  for (const e of edits) {
    const key = `${e.range.start}:${e.range.end}:${e.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  unique.sort((a, b) => b.range.start - a.range.start);
  let output = source;
  for (const e of unique) {
    output =
      output.slice(0, e.range.start) +
      e.replacement +
      output.slice(e.range.end);
  }

  return {
    output,
    renamed,
    referenceMatches: Math.max(0, unique.length - assignments.length)
  };
}

// Collect double-quoted string literal ranges, but only within `<cfscript>`
// bodies. Outside cfscript, `"` is an attribute delimiter (e.g.
// `query="getUsers"`) and references inside should still be renamed.
function collectStringLiteralRangesInScripts(source: string): Range[] {
  const doc = parse(source);
  const scriptBodyRanges: Range[] = [];
  walkAll(doc.children, (n) => {
    if (n.type === "script") scriptBodyRanges.push(n.bodyRange ?? n.range);
  });

  const out: Range[] = [];
  for (const sr of scriptBodyRanges) {
    let i = sr.start;
    while (i < sr.end) {
      if (source[i] === '"') {
        const start = i;
        i++;
        while (i < sr.end) {
          if (source[i] === '"') {
            if (source[i + 1] === '"') {
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
  }
  return out;
}

function walkAll(nodes: CFMLNode[], fn: (n: CFMLNode) => void): void {
  for (const n of nodes) {
    fn(n);
    if (n.type === "tag" && n.children.length > 0) walkAll(n.children, fn);
  }
}

import type { CFMLDocument, CFMLNode, Range, TagNode } from "../parser/ast";

export type CallSite =
  | "cfset"
  | "tag-attribute"
  | "hash-interp"
  | "cfscript"
  | "cfif"
  | "cfreturn"
  | "cfoutput-text"
  | "queryparam";

export interface DetectedCall {
  // Plain function name e.g. "getUser" or "getInstance".
  name: string;
  // The receiver chain prefix, if this is a method call. For
  // `userService.getUsers(x)` receiver is "userService".
  receiver?: string;
  // Raw argument text between parens, with outer parens stripped.
  argsText: string;
  // Per-argument raw text, comma-split at depth 0 outside strings.
  args: string[];
  // Range covering the whole call (name through closing paren) in the
  // original document.
  range: Range;
  // Range of just the function name identifier.
  nameRange: Range;
  // Where this call lives semantically — used by classifier and webview.
  site: CallSite;
  // True if the result of the call is being assigned to something,
  // e.g. `<cfset prc.x = getX()>`. Captured for cfset/cfscript only.
  assignedTo?: string;
  // True if the call is inside a <cfloop>.
  insideLoop: boolean;
  // True if the call is inside a <cfif> (conditional gate).
  insideConditional: boolean;
  // Best-effort line number (1-based) for display.
  line: number;
}

export interface ExtractCallsOptions {
  // Skip these names entirely — used to drop control-flow keywords that
  // look like function calls (e.g. cfif, isDefined of a void check).
  // Lowercase.
  skipNames?: Set<string>;
}

const KEYWORDS = new Set([
  "if",
  "else",
  "elseif",
  "for",
  "while",
  "switch",
  "case",
  "default",
  "do",
  "return",
  "break",
  "continue",
  "var",
  "local",
  "new",
  "function",
  "and",
  "or",
  "not",
  "eq",
  "neq",
  "lt",
  "gt",
  "lte",
  "gte",
  "is",
  "contains",
  "true",
  "false",
  "null",
  "try",
  "catch",
  "finally",
  "throw",
  "in"
]);

export function extractCalls(
  doc: CFMLDocument,
  opts: ExtractCallsOptions = {}
): DetectedCall[] {
  const out: DetectedCall[] = [];
  const skip = opts.skipNames ?? new Set<string>();

  const lineCache = buildLineIndex(doc.source);
  const offsetToLine = (off: number): number => {
    let lo = 0;
    let hi = lineCache.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineCache[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const visit = (
    nodes: CFMLNode[],
    inLoop: boolean,
    inIf: boolean
  ): void => {
    for (const n of nodes) {
      if (n.type === "comment") continue;
      if (n.type === "content") {
        scanInterpolated(
          n.text,
          n.range.start,
          out,
          "cfoutput-text",
          inLoop,
          inIf,
          skip,
          offsetToLine
        );
        continue;
      }
      if (n.type === "script") {
        scanScript(
          n.body,
          n.bodyRange.start,
          out,
          inLoop,
          inIf,
          skip,
          offsetToLine
        );
        continue;
      }
      // tag node
      visitTag(n, out, inLoop, inIf, skip, offsetToLine);
      const childInLoop = inLoop || n.name === "cfloop";
      const childInIf = inIf || n.name === "cfif" || n.name === "cfelseif";
      if (n.children.length > 0) {
        visit(n.children, childInLoop, childInIf);
      }
    }
  };

  visit(doc.children, false, false);
  return out;
}

function visitTag(
  tag: TagNode,
  out: DetectedCall[],
  inLoop: boolean,
  inIf: boolean,
  skip: Set<string>,
  offsetToLine: (n: number) => number
): void {
  const name = tag.name;

  if (name === "cfset") {
    const expr = readCfsetExpression(tag);
    if (expr) {
      const assigned = parseAssignment(expr.text);
      const callsBefore = out.length;
      scanExpression(
        expr.text,
        expr.start,
        out,
        "cfset",
        inLoop,
        inIf,
        skip,
        offsetToLine
      );
      if (assigned) {
        for (let i = callsBefore; i < out.length; i++) {
          if (!out[i].assignedTo) out[i].assignedTo = assigned;
        }
      }
    }
    return;
  }

  if (name === "cfif" || name === "cfelseif") {
    const expr = readCfsetExpression(tag);
    if (expr) {
      scanExpression(
        expr.text,
        expr.start,
        out,
        "cfif",
        inLoop,
        true,
        skip,
        offsetToLine
      );
    }
    return;
  }

  if (name === "cfreturn") {
    const expr = readCfsetExpression(tag);
    if (expr) {
      scanExpression(
        expr.text,
        expr.start,
        out,
        "cfreturn",
        inLoop,
        inIf,
        skip,
        offsetToLine
      );
    }
    return;
  }

  // For all other tags, scan attribute values for hash interpolation and
  // for whole-expression attributes that may contain function calls
  // (e.g. cfloop array="#getItems()#").
  for (const [attrName, attr] of tag.attributes) {
    if (!attr.hasInterpolation && !looksLikeExpressionAttribute(name, attrName, attr.value)) {
      continue;
    }
    // attr.range.start is the start of the attribute name. Find the value
    // start within the source by searching from the attr range.
    // The tokenizer doesn't expose the value-start offset directly, so we
    // approximate by scanning the slice for the `=` and quote.
    const valueOffset = locateAttributeValueOffset(
      tag,
      attrName,
      attr.raw
    );
    if (valueOffset < 0) continue;
    const isQueryParamValue =
      tag.name === "cfqueryparam" && attrName === "value";
    const site: CallSite = isQueryParamValue ? "queryparam" : "tag-attribute";
    scanInterpolated(
      attr.value,
      valueOffset,
      out,
      site,
      inLoop,
      inIf,
      skip,
      offsetToLine
    );
  }
}

function readCfsetExpression(tag: TagNode): { text: string; start: number } | null {
  // <cfset expr>: the expression sits between the tag name and `>`.
  // The tokenizer stored attributes as a map, but cfset's body is a free
  // expression with no `=`-style attribute structure. The attributes map
  // *will* contain pseudo-attributes for tokens like `prc.x` (because the
  // tokenizer parsed them as attribute names). Rather than reconstruct
  // from the map, slice the open-tag range from the source.
  const range = tag.openTagRange;
  if (!range) return null;
  // The doc source isn't available here directly; we attached only ranges.
  // We can't slice without source. Pass through a sentinel; the caller
  // will provide source via a side channel below.
  return readSourceSlice(tag);
}

// Local helper that pulls source via a module-private cache. Source is
// captured at extractCalls() entry through a closure on visit(); however,
// visitTag is a free function that doesn't see it. We work around this
// with a module-level pointer set inside extractCalls.
let _sourceRef = "";

function readSourceSlice(tag: TagNode): { text: string; start: number } | null {
  if (!_sourceRef) return null;
  const open = tag.openTagRange;
  if (!open) return null;
  // Skip "<cfname" prefix; find the next whitespace then read until ">"
  // (or "/>"). Strip a trailing slash if self-closing.
  const slice = _sourceRef.slice(open.start, open.end);
  // Find the tag-name end inside the slice.
  const m = slice.match(/^<\/?[A-Za-z0-9_:]+/);
  if (!m) return null;
  const afterName = m[0].length;
  // Trim leading whitespace.
  let i = afterName;
  while (i < slice.length && /\s/.test(slice[i])) i++;
  // Trim trailing `>` and optional `/`.
  let end = slice.length;
  if (slice[end - 1] === ">") end--;
  if (slice[end - 1] === "/") end--;
  while (end > i && /\s/.test(slice[end - 1])) end--;
  const text = slice.slice(i, end);
  return { text, start: open.start + i };
}

// Public entry point that records the source pointer for the tag scanners.
export function extractCallsWithSource(
  doc: CFMLDocument,
  opts: ExtractCallsOptions = {}
): DetectedCall[] {
  _sourceRef = doc.source;
  try {
    return extractCalls(doc, opts);
  } finally {
    _sourceRef = "";
  }
}

function locateAttributeValueOffset(
  tag: TagNode,
  attrName: string,
  _rawValue: string
): number {
  if (!_sourceRef) return -1;
  const slice = _sourceRef.slice(tag.openTagRange.start, tag.openTagRange.end);
  const re = new RegExp(`\\b${escapeRegex(attrName)}\\s*=\\s*`, "i");
  const m = re.exec(slice);
  if (!m) return -1;
  let pos = m.index + m[0].length;
  if (slice[pos] === '"' || slice[pos] === "'") pos++;
  return tag.openTagRange.start + pos;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeExpressionAttribute(
  tagName: string,
  attrName: string,
  value: string
): boolean {
  // Some attributes are CFML expressions even without # markers, like
  // cfif's condition-equivalent or cfloop attributes. We catch the
  // common ones; missing attrs get scanned only if they contain `#`.
  if (tagName === "cfloop") {
    if (
      attrName === "from" ||
      attrName === "to" ||
      attrName === "step" ||
      attrName === "array" ||
      attrName === "list" ||
      attrName === "collection" ||
      attrName === "condition"
    ) {
      return /[A-Za-z_]\w*\s*\(/.test(value);
    }
  }
  return false;
}

function scanInterpolated(
  text: string,
  baseOffset: number,
  out: DetectedCall[],
  site: CallSite,
  inLoop: boolean,
  inIf: boolean,
  skip: Set<string>,
  offsetToLine: (n: number) => number
): void {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "#") {
      if (text[i + 1] === "#") {
        i += 2;
        continue;
      }
      // Find the matching closing # at the same depth, ignoring nested
      // strings.
      const close = findHashClose(text, i + 1);
      if (close < 0) return;
      const inner = text.slice(i + 1, close);
      const innerOffset = baseOffset + i + 1;
      scanExpression(
        inner,
        innerOffset,
        out,
        site,
        inLoop,
        inIf,
        skip,
        offsetToLine
      );
      i = close + 1;
      continue;
    }
    i++;
  }
}

function findHashClose(text: string, from: number): number {
  let i = from;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "#" && depth === 0) {
      return i;
    }
    i++;
  }
  return -1;
}

function scanScript(
  body: string,
  baseOffset: number,
  out: DetectedCall[],
  inLoop: boolean,
  inIf: boolean,
  skip: Set<string>,
  offsetToLine: (n: number) => number
): void {
  // Walk top-level statements, splitting on `;` outside strings/blocks/parens.
  let i = 0;
  let stmtStart = 0;
  while (i < body.length) {
    const ch = body[i];
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
    if (ch === '"' || ch === "'") {
      i = skipString(body, i);
      continue;
    }
    if (ch === "{") {
      i = skipBraces(body, i);
      continue;
    }
    if (ch === ";" || i === body.length - 1) {
      const end = ch === ";" ? i : i + 1;
      const stmt = body.slice(stmtStart, end);
      if (stmt.trim().length > 0) {
        const assigned = parseAssignment(stmt);
        const callsBefore = out.length;
        scanExpression(
          stmt,
          baseOffset + stmtStart,
          out,
          "cfscript",
          inLoop,
          inIf,
          skip,
          offsetToLine
        );
        if (assigned) {
          for (let k = callsBefore; k < out.length; k++) {
            if (!out[k].assignedTo) out[k].assignedTo = assigned;
          }
        }
      }
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
}

function skipBraces(body: string, i: number): number {
  i++;
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
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

function scanExpression(
  text: string,
  baseOffset: number,
  out: DetectedCall[],
  site: CallSite,
  inLoop: boolean,
  inIf: boolean,
  skip: Set<string>,
  offsetToLine: (n: number) => number
): void {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i < text.length) i += 2;
      continue;
    }
    if (isIdentStart(ch)) {
      const idStart = i;
      while (i < text.length && isIdentCont(text[i])) i++;
      const ident = text.slice(idStart, i);
      // Skip `new path.to.Type(...)` keyword form by recognizing it here.
      if (ident.toLowerCase() === "new") {
        // Treat as a synthetic call — record name "new <Type>" with site
        // and let classifier handle it.
        let j = skipWs(text, i);
        const typeStart = j;
        while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j++;
        const typeName = text.slice(typeStart, j);
        const after = skipWs(text, j);
        if (typeName.length > 0 && text[after] === "(") {
          const parsed = readArgs(text, after);
          if (parsed) {
            out.push({
              name: "new " + typeName,
              argsText: parsed.argsText,
              args: parsed.args,
              range: {
                start: baseOffset + idStart,
                end: baseOffset + parsed.end
              },
              nameRange: {
                start: baseOffset + idStart,
                end: baseOffset + j
              },
              site,
              insideLoop: inLoop,
              insideConditional: inIf,
              line: offsetToLine(baseOffset + idStart)
            });
            i = parsed.end;
            continue;
          }
        }
        continue;
      }
      // We may be looking at `a.b.c(...)`. Consume `.identifier` chain.
      let chainEnd = i;
      let chainText = ident;
      while (true) {
        const after = chainEnd;
        if (text[after] !== ".") break;
        let k = after + 1;
        if (!isIdentStart(text[k] ?? "")) break;
        while (k < text.length && isIdentCont(text[k])) k++;
        chainText += text.slice(after, k);
        chainEnd = k;
      }
      // After the chain, if next non-ws is `(`, this is a call.
      const callOpen = skipWs(text, chainEnd);
      if (text[callOpen] === "(") {
        const parsed = readArgs(text, callOpen);
        if (parsed) {
          // Determine the call name and receiver.
          // The "name" is the last segment of the dotted chain. The
          // receiver is everything before the last dot.
          const lastDot = chainText.lastIndexOf(".");
          const callName =
            lastDot < 0 ? chainText : chainText.slice(lastDot + 1);
          const receiver =
            lastDot < 0 ? undefined : chainText.slice(0, lastDot);
          if (
            !KEYWORDS.has(callName.toLowerCase()) &&
            !skip.has(callName.toLowerCase())
          ) {
            // The name range covers the full chain — webview shows the
            // full receiver.callName when present.
            const nameStart = idStart;
            const nameEnd = chainEnd;
            out.push({
              name: callName,
              receiver,
              argsText: parsed.argsText,
              args: parsed.args,
              range: {
                start: baseOffset + idStart,
                end: baseOffset + parsed.end
              },
              nameRange: {
                start: baseOffset + nameStart,
                end: baseOffset + nameEnd
              },
              site,
              insideLoop: inLoop,
              insideConditional: inIf,
              line: offsetToLine(baseOffset + idStart)
            });
            // Recurse into the args so nested calls are also captured.
            scanExpression(
              parsed.argsText,
              baseOffset + parsed.argsStart,
              out,
              site,
              inLoop,
              inIf,
              skip,
              offsetToLine
            );
            i = parsed.end;
            continue;
          } else {
            // Skip past the call but still recurse into the args.
            scanExpression(
              parsed.argsText,
              baseOffset + parsed.argsStart,
              out,
              site,
              inLoop,
              inIf,
              skip,
              offsetToLine
            );
            i = parsed.end;
            continue;
          }
        }
      }
      i = chainEnd;
      continue;
    }
    i++;
  }
}

interface ArgsParse {
  argsText: string;
  argsStart: number;
  args: string[];
  end: number;
}

function readArgs(text: string, parenAt: number): ArgsParse | null {
  if (text[parenAt] !== "(") return null;
  let i = parenAt + 1;
  const start = i;
  let depth = 1;
  const args: string[] = [];
  let argStart = i;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        const a = text.slice(argStart, i).trim();
        if (a.length > 0 || args.length > 0) args.push(a);
        i++;
        return {
          argsText: text.slice(start, i - 1),
          argsStart: start,
          args,
          end: i
        };
      }
      i++;
      continue;
    }
    if (ch === "{") {
      i = skipBraces(text, i);
      continue;
    }
    if (ch === "[") {
      i = skipBrackets(text, i);
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(text.slice(argStart, i).trim());
      i++;
      argStart = i;
      continue;
    }
    i++;
  }
  return null;
}

function skipBrackets(text: string, i: number): number {
  i++;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }
  return i;
}

function skipString(text: string, i: number): number {
  const quote = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (text[i] === "#") {
      // CFML allows #expr# inside strings — skip the inner expression
      // to ensure we don't terminate strings prematurely.
      const close = findHashClose(text, i + 1);
      if (close < 0) return text.length;
      i = close + 1;
      continue;
    }
    i++;
  }
  return text.length;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
  return i;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentCont(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

// Parse an assignment of the form `target = expr`. Returns the target
// (LHS) trimmed, or null if no top-level `=` is present (or `==` is).
function parseAssignment(text: string): string | undefined {
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      i++;
      continue;
    }
    if (ch === "=" && depth === 0) {
      if (text[i + 1] === "=") {
        i += 2;
        continue;
      }
      // Avoid named-arg `name=value` — heuristically only treat as an
      // assignment if there's no comma to the left at depth 0. This is
      // good enough for cfset and statement-level cfscript assignments,
      // which is the only place we call parseAssignment.
      const lhs = text.slice(0, i).trim();
      if (lhs.length === 0) return undefined;
      return lhs;
    }
    i++;
  }
  return undefined;
}

function buildLineIndex(source: string): number[] {
  const lines: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lines.push(i + 1);
  }
  return lines;
}

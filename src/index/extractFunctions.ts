import { parse } from "../parser/parse";
import type { CFMLDocument, CFMLNode, TagNode } from "../parser/ast";
import type { IndexedContext, IndexedFunction } from "./types";

export interface ExtractFunctionsOptions {
  filePath: string;
  context: IndexedContext;
}

export function extractFunctionsFromFile(
  source: string,
  opts: ExtractFunctionsOptions
): IndexedFunction[] {
  const out: IndexedFunction[] = [];
  const doc = parse(source);
  collectTagFunctions(doc.children, source, opts, out);
  collectScriptFunctions(doc, source, opts, out);
  return out;
}

function collectTagFunctions(
  nodes: CFMLNode[],
  _source: string,
  opts: ExtractFunctionsOptions,
  out: IndexedFunction[]
): void {
  for (const n of nodes) {
    if (n.type === "tag") {
      if (n.name === "cffunction") {
        out.push(buildFromCffunction(n, opts));
      }
      if (n.children.length > 0) {
        collectTagFunctions(n.children, _source, opts, out);
      }
    }
  }
}

function buildFromCffunction(
  tag: TagNode,
  opts: ExtractFunctionsOptions
): IndexedFunction {
  const name = tag.attributes.get("name")?.value ?? "(unnamed)";
  const access = tag.attributes.get("access")?.value?.toLowerCase() ?? "public";
  const args: string[] = [];
  for (const child of tag.children) {
    if (child.type !== "tag") continue;
    if (child.name === "cfargument") {
      const argName = child.attributes.get("name")?.value;
      if (argName) args.push(argName);
    }
  }
  return {
    name,
    filePath: opts.filePath,
    range: { start: tag.range.start, end: tag.range.end },
    argumentList: args,
    context: opts.context,
    isPublic: access === "public" || access === "remote"
  };
}

function collectScriptFunctions(
  doc: CFMLDocument,
  source: string,
  opts: ExtractFunctionsOptions,
  out: IndexedFunction[]
): void {
  // Walk script blocks attached to <cfscript> nodes.
  const blocks: Array<{ body: string; offset: number }> = [];
  const visit = (nodes: CFMLNode[]): void => {
    for (const n of nodes) {
      if (n.type === "script") {
        blocks.push({ body: n.body, offset: n.bodyRange.start });
      } else if (n.type === "tag" && n.children.length > 0) {
        visit(n.children);
      }
    }
  };
  visit(doc.children);

  // For script-only CFCs (no <cfcomponent>), the entire source is the
  // script body. Detect via lack of <cfcomponent> tag.
  const lower = opts.filePath.toLowerCase();
  if (lower.endsWith(".cfc") && !/<cfcomponent\b/i.test(source) && blocks.length === 0) {
    blocks.push({ body: source, offset: 0 });
  }

  for (const b of blocks) {
    parseScriptFunctions(b.body, b.offset, opts, out);
  }
}

function parseScriptFunctions(
  body: string,
  baseOffset: number,
  opts: ExtractFunctionsOptions,
  out: IndexedFunction[]
): void {
  let i = 0;
  let lastIsPublic = true;
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
      i = skipStr(body, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const idStart = i;
      while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
      const ident = body.slice(idStart, i).toLowerCase();
      if (
        ident === "public" ||
        ident === "private" ||
        ident === "package" ||
        ident === "remote"
      ) {
        lastIsPublic = ident === "public" || ident === "remote";
        // Continue — the next token may be a return type or "function".
        continue;
      }
      if (ident === "function") {
        // Parse: function NAME(arg1, arg2)
        let j = skipWs(body, i);
        const nameStart = j;
        while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
        const fnName = body.slice(nameStart, j);
        if (fnName.length === 0) continue;
        let k = skipWs(body, j);
        if (body[k] !== "(") {
          i = j;
          continue;
        }
        const args = readArgNames(body, k);
        if (!args) {
          i = j;
          continue;
        }
        // Skip past the function body to find its end.
        let m = skipWs(body, args.endParen);
        if (body[m] === "{") {
          m = skipBraces(body, m);
        }
        out.push({
          name: fnName,
          filePath: opts.filePath,
          range: { start: baseOffset + idStart, end: baseOffset + m },
          argumentList: args.names,
          context: opts.context,
          isPublic: lastIsPublic
        });
        i = m;
        lastIsPublic = true;
        continue;
      }
      // Other identifiers — likely a return type between the modifier
      // and `function`. Don't touch lastIsPublic.
      continue;
    }
    if (ch === ";" || ch === "}") {
      // End of a statement or scope — clear any pending modifier.
      lastIsPublic = true;
    }
    i++;
  }
}

function readArgNames(body: string, parenAt: number): { names: string[]; endParen: number } | null {
  if (body[parenAt] !== "(") return null;
  let i = parenAt + 1;
  const names: string[] = [];
  let depth = 1;
  let argStart = i;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      i = skipStr(body, i);
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
        const tail = body.slice(argStart, i).trim();
        if (tail.length > 0) names.push(extractArgName(tail));
        return { names, endParen: i + 1 };
      }
      i++;
      continue;
    }
    if (ch === "," && depth === 1) {
      const tail = body.slice(argStart, i).trim();
      if (tail.length > 0) names.push(extractArgName(tail));
      argStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  return null;
}

function extractArgName(arg: string): string {
  // CFML script arg syntax can be: required type name = default
  // e.g. "required numeric deptId = 0". Take the last identifier before
  // an `=` (or end).
  let head = arg;
  const eqIdx = head.indexOf("=");
  if (eqIdx >= 0) head = head.slice(0, eqIdx).trim();
  const tokens = head.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return arg;
  return tokens[tokens.length - 1];
}

function skipBraces(body: string, i: number): number {
  i++;
  let depth = 1;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      i = skipStr(body, i);
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

function skipStr(body: string, i: number): number {
  const q = body[i];
  i++;
  while (i < body.length) {
    if (body[i] === q) {
      if (body[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (body[i] === "#") {
      const close = body.indexOf("#", i + 1);
      if (close < 0) return body.length;
      i = close + 1;
      continue;
    }
    i++;
  }
  return body.length;
}

function skipWs(body: string, i: number): number {
  while (i < body.length && /\s/.test(body[i])) i++;
  return i;
}

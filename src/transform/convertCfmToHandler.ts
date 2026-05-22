import type {
  AttributeValue,
  CFMLNode,
  CommentNode,
  ContentNode,
  ScriptNode,
  TagNode
} from "../parser/ast";
import { parse } from "../parser/parse";
import { analyze } from "../analyzer/findQueries";
import {
  shouldSkipTransform,
  transformQuery,
  type TransformOptions
} from "./convertQuery";

export interface ConvertCfmOptions {
  actionName: string;
  viewPath: string;
  scopeStyle?: "var" | "local";
  tabUnit?: string;
  defaultDatasourcePatterns?: string[];
}

export interface RescopedVar {
  name: string;
  mode: "var" | "prc" | "local";
}

export interface TodoEntry {
  tag: string;
  raw: string;
}

export interface ConvertCfmResult {
  handlerBody: string;
  hasView: boolean;
  viewBody: string;
  todos: TodoEntry[];
  tagsConverted: number;
  rescoped: RescopedVar[];
  setViewCall: string | undefined;
  querySkipped: Array<{ name: string; reason: string }>;
}

const CFML_SCOPES = new Set([
  "url",
  "form",
  "rc",
  "prc",
  "arguments",
  "session",
  "application",
  "request",
  "cgi",
  "cookie",
  "server",
  "client",
  "this",
  "super",
  "variables",
  "local",
  "event",
  "form"
]);

// Data-access tags must always be converted to cfscript in the handler. A
// container that holds one (anywhere in its subtree) is therefore handler
// logic, never view markup — the query has to move out even if the container
// also wraps presentation.
const DATA_ACCESS_TAGS = new Set(["cfquery", "cfstoredproc"]);

// Attributes whose value is a bare variable reference (no #...#) that the view
// may share with the handler, so they participate in prc rescoping.
const VIEW_REF_ATTRS = ["query", "array", "collection", "condition"];

interface EmitContext {
  source: string;
  indent: string;
  baseIndent: string;
  tabUnit: string;
  scopeStyle: "var" | "local";
  cfqueryReplacements: Map<number, string | { skipReason: string }>;
  todos: TodoEntry[];
  tagsConverted: { n: number };
  querySkipped: Array<{ name: string; reason: string }>;
  modes: Map<string, "var" | "prc" | "local">;
  prcNames: Set<string>;
}

export function convertCfmToHandler(
  source: string,
  options: ConvertCfmOptions
): ConvertCfmResult {
  const tabUnit = options.tabUnit ?? "    ";
  const scopeStyle = options.scopeStyle ?? "var";
  const baseIndent = tabUnit + tabUnit;

  const transformOpts: TransformOptions = {
    tabUnit,
    defaultDatasourcePatterns: options.defaultDatasourcePatterns
  };

  const doc = parse(source);
  const analysis = analyze(doc);

  const cfqueryReplacements = new Map<
    number,
    string | { skipReason: string }
  >();
  const querySkipped: Array<{ name: string; reason: string }> = [];
  for (const q of analysis.queries) {
    const skip = shouldSkipTransform(q);
    if (skip) {
      cfqueryReplacements.set(q.range.start, { skipReason: skip.reason });
      querySkipped.push({ name: q.name, reason: skip.reason });
      continue;
    }
    const t = transformQuery(q, source, transformOpts);
    cfqueryReplacements.set(q.range.start, t.replacement);
  }

  const candidates = collectCandidateNames(doc.children, source);
  const viewReferenced = collectViewReferenced(doc.children, source);
  const modes = computeModes(candidates, viewReferenced, scopeStyle);
  const prcNames = new Set<string>();
  for (const [name, mode] of modes) {
    if (mode === "prc") prcNames.add(name);
  }

  const ctx: EmitContext = {
    source,
    indent: baseIndent,
    baseIndent,
    tabUnit,
    scopeStyle,
    cfqueryReplacements,
    todos: [],
    tagsConverted: { n: 0 },
    querySkipped,
    modes,
    prcNames
  };

  const split = processNodes(doc.children, ctx);
  const handlerBody = applyScoping(
    trimBlankRuns(split.handler.join("\n")),
    modes
  );

  const hasView = split.view.trim().length > 0;
  const setViewCall = hasView
    ? `event.setView( "${options.viewPath}" );`
    : undefined;

  const rescoped: RescopedVar[] = [];
  for (const [lowerName, mode] of modes) {
    const display = candidates.get(lowerName) ?? lowerName;
    rescoped.push({ name: display, mode });
  }

  return {
    handlerBody,
    hasView,
    viewBody: hasView ? split.view : "",
    todos: ctx.todos,
    tagsConverted: ctx.tagsConverted.n,
    rescoped,
    setViewCall,
    querySkipped
  };
}

// --- Recursive handler/view split -----------------------------------------
//
// Each node is partitioned into a handler part (cfscript) and a view part
// (markup). Pure logic flows entirely to the handler, pure markup entirely to
// the view, and mixed containers are split: a <cfif> duplicates its condition,
// a <cfoutput> splits its children, and a <cfloop> holding a query becomes a
// view model — the handler reproduces the loop to pre-build a keyed struct
// that the view reads back, one entry per iteration.

interface SplitText {
  handler: string[];
  view: string;
}

function processNodes(nodes: CFMLNode[], ctx: EmitContext): SplitText {
  const handler: string[] = [];
  let view = "";
  for (const node of nodes) {
    const r = processNode(node, ctx);
    handler.push(...r.handler);
    view += r.view;
  }
  return { handler, view };
}

function processNode(node: CFMLNode, ctx: EmitContext): SplitText {
  if (node.type === "content") {
    return {
      handler: [],
      view: rewriteInterpolations(node.text, ctx.prcNames)
    };
  }
  if (node.type === "comment" || node.type === "script") {
    return { handler: emitToHandler(node, ctx), view: "" };
  }
  switch (node.name) {
    case "cfoutput":
      return processCfoutput(node, ctx);
    case "cfif":
      return processCfif(node, ctx);
    case "cfloop":
      return processCfloop(node, ctx);
    case "cfswitch":
      return processCfswitch(node, ctx);
    default:
      return { handler: emitToHandler(node, ctx), view: "" };
  }
}

function emitToHandler(node: CFMLNode, ctx: EmitContext): string[] {
  const lines: string[] = [];
  emitNode(node, ctx, lines);
  return lines;
}

function nodesHaveMarkup(nodes: CFMLNode[]): boolean {
  for (const n of nodes) {
    if (n.type === "content" && n.text.trim().length > 0) return true;
    if (n.type === "tag") {
      if (n.name === "cfoutput") return true;
      if (tagContainsMarkup(n)) return true;
    }
  }
  return false;
}

function processCfoutput(node: TagNode, ctx: EmitContext): SplitText {
  if (!tagContainsDataAccess(node)) {
    return {
      handler: [],
      view: rewriteViewSource([node], ctx.source, ctx.prcNames)
    };
  }
  const inner = processNodes(node.children, ctx);
  if (inner.view.trim().length === 0) {
    return { handler: inner.handler, view: "" };
  }
  const open = rewriteViewTagOpen(
    ctx.source.slice(node.openTagRange.start, node.openTagRange.end),
    node,
    ctx.prcNames
  );
  const close = node.closeTagRange
    ? ctx.source.slice(node.closeTagRange.start, node.closeTagRange.end)
    : "</cfoutput>";
  return { handler: inner.handler, view: open + inner.view + close };
}

function processCfif(node: TagNode, ctx: EmitContext): SplitText {
  const branches = splitIfBranches(node, ctx.source);
  if (!branches.some((b) => nodesHaveMarkup(b.children))) {
    return { handler: emitToHandler(node, ctx), view: "" };
  }
  if (!tagContainsDataAccess(node)) {
    return {
      handler: [],
      view: rewriteViewSource([node], ctx.source, ctx.prcNames)
    };
  }
  // Mixed: the condition is duplicated — guarded logic in the handler,
  // guarded markup in the view.
  const handler: string[] = [];
  let view = "";
  const innerCtx: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  branches.forEach((b, i) => {
    const cond = b.condition ?? "true";
    if (i === 0) handler.push(`${ctx.indent}if (${cond}) {`);
    else if (b.kind === "elseif") {
      handler.push(`${ctx.indent}} else if (${cond}) {`);
    } else handler.push(`${ctx.indent}} else {`);
    const inner = processNodes(b.children, innerCtx);
    handler.push(...inner.handler);

    const viewCond = rewriteExprIdents(cond, ctx.prcNames);
    if (i === 0) view += `<cfif ${viewCond}>`;
    else if (b.kind === "elseif") view += `<cfelseif ${viewCond}>`;
    else view += `<cfelse>`;
    view += inner.view;
  });
  handler.push(`${ctx.indent}}`);
  view += `</cfif>`;
  ctx.tagsConverted.n++;
  return { handler, view };
}

function processCfloop(node: TagNode, ctx: EmitContext): SplitText {
  if (!tagContainsMarkup(node)) {
    return { handler: emitToHandler(node, ctx), view: "" };
  }
  if (!tagContainsDataAccess(node)) {
    return {
      handler: [],
      view: rewriteViewSource([node], ctx.source, ctx.prcNames)
    };
  }
  const vm = emitViewModelLoop(node, ctx);
  if (vm) return vm;
  // Could not build a view model — convert the whole loop to the handler so
  // its logic is not lost (its markup becomes TODO comments).
  return { handler: emitToHandler(node, ctx), view: "" };
}

function processCfswitch(node: TagNode, ctx: EmitContext): SplitText {
  if (!tagContainsMarkup(node)) {
    return { handler: emitToHandler(node, ctx), view: "" };
  }
  if (!tagContainsDataAccess(node)) {
    return {
      handler: [],
      view: rewriteViewSource([node], ctx.source, ctx.prcNames)
    };
  }
  // A mixed <cfswitch> is uncommon — convert it whole so no logic is lost.
  return { handler: emitToHandler(node, ctx), view: "" };
}

// Build a view model for a <cfloop> that wraps both markup and a query: the
// handler reproduces the loop to fill prc.<query> keyed by iteration, and the
// view keeps the loop, re-localizing each query from prc per iteration so the
// surrounding markup is otherwise unchanged. Returns undefined when the loop
// shape is not one this transform can safely restructure.
function emitViewModelLoop(
  node: TagNode,
  ctx: EmitContext
): SplitText | undefined {
  const attrs = node.attributes;
  let handlerHeader: string;
  let keyExpr: string;

  if (attrs.has("query")) {
    const q = attrs.get("query")!.value;
    if (!/^[A-Za-z_]\w*$/.test(q)) return undefined;
    const prcQ = ctx.prcNames.has(q.toLowerCase()) ? `prc.${q}` : q;
    handlerHeader = `cfloop( query="${prcQ}" ) {`;
    keyExpr = `${prcQ}.currentRow`;
  } else if (
    attrs.has("from") &&
    attrs.has("to") &&
    (attrs.has("index") || attrs.has("item")) &&
    !attrs.has("step")
  ) {
    const idx = (attrs.get("index") ?? attrs.get("item"))!.value;
    if (!/^[A-Za-z_]\w*$/.test(idx)) return undefined;
    const from = unwrapAttr(attrs.get("from")!);
    const to = unwrapAttr(attrs.get("to")!);
    handlerHeader = `for ( var ${idx} = ${from}; ${idx} <= ${to}; ${idx}++ ) {`;
    keyExpr = idx;
  } else {
    return undefined;
  }

  // Every query must be a direct child we can name and convert; anything
  // deeper (a query inside a nested loop or if) is beyond this transform.
  const dataChildren: TagNode[] = [];
  for (const child of node.children) {
    if (child.type !== "tag") continue;
    if (DATA_ACCESS_TAGS.has(child.name)) dataChildren.push(child);
    else if (tagContainsDataAccess(child)) return undefined;
  }
  if (dataChildren.length === 0) return undefined;

  const extracted: Array<{ name: string; conversion: string }> = [];
  for (const dc of dataChildren) {
    const name = dc.attributes.get("name")?.value;
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) return undefined;
    const repl = ctx.cfqueryReplacements.get(dc.range.start);
    if (typeof repl !== "string") return undefined;
    extracted.push({ name, conversion: repl });
  }

  const innerIndent = ctx.indent + ctx.tabUnit;

  const handler: string[] = [];
  for (const e of extracted) {
    handler.push(`${ctx.indent}prc.${e.name} = {};`);
  }
  handler.push(`${ctx.indent}${handlerHeader}`);
  for (const e of extracted) {
    const body = dedentReindent(
      stripCfscriptWrapper(e.conversion),
      innerIndent
    );
    const keyed = body.replace(
      new RegExp(`^(\\s*)${escapeRegex(e.name)}(\\s*=\\s*queryExecute)`, "m"),
      `$1prc.${e.name}[ ${keyExpr} ]$2`
    );
    for (const l of keyed.split("\n")) handler.push(l);
    ctx.tagsConverted.n++;
  }
  handler.push(`${ctx.indent}}`);

  // References to the extracted queries are re-localized per iteration in the
  // view, so the surrounding markup keeps using their original names.
  const localPrc = new Set(ctx.prcNames);
  for (const e of extracted) localPrc.delete(e.name.toLowerCase());

  const loopOpen = rewriteViewTagOpen(
    ctx.source.slice(node.openTagRange.start, node.openTagRange.end),
    node,
    ctx.prcNames
  );
  const loopClose = node.closeTagRange
    ? ctx.source.slice(node.closeTagRange.start, node.closeTagRange.end)
    : "</cfloop>";
  const restChildren = node.children.filter(
    (c) => !(c.type === "tag" && DATA_ACCESS_TAGS.has(c.name))
  );
  const restView = rewriteViewSource(restChildren, ctx.source, localPrc);

  const indent = lineIndentAt(ctx.source, node.openTagRange.start);
  let inject = "";
  for (const e of extracted) {
    inject +=
      `\n${indent}${ctx.tabUnit}` +
      `<cfset ${e.name} = prc.${e.name}[ ${keyExpr} ]>`;
  }

  ctx.tagsConverted.n++;
  return { handler, view: loopOpen + inject + restView + loopClose };
}

function lineIndentAt(source: string, pos: number): string {
  let start = pos;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let i = start;
  while (i < pos && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(start, i);
}

// True when the tag's subtree contains a data-access tag (<cfquery> etc.).
function tagContainsDataAccess(node: TagNode): boolean {
  for (const child of node.children) {
    if (child.type !== "tag") continue;
    if (DATA_ACCESS_TAGS.has(child.name)) return true;
    if (tagContainsDataAccess(child)) return true;
  }
  return false;
}

// True when a tag's subtree contains presentation markup — raw HTML/text or a
// <cfoutput> block — meaning the tag is layout that belongs in the view.
function tagContainsMarkup(node: TagNode): boolean {
  for (const child of node.children) {
    if (child.type === "content" && child.text.trim().length > 0) {
      return true;
    }
    if (child.type === "tag") {
      if (child.name === "cfoutput") return true;
      if (tagContainsMarkup(child)) return true;
    }
  }
  return false;
}

// Identifier references that decide which handler variables must be shared
// with the view (and so become `prc`). Scans #...# interpolations plus the
// expression-bearing attributes and <cfif> conditions of the view tags.
function collectViewReferenced(
  nodes: CFMLNode[],
  source: string
): Set<string> {
  const out = new Set<string>();

  const collectIdents = (expr: string): void => {
    const idRe = /(^|[^.\w])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(expr)) !== null) {
      const root = im[2];
      const child = im[3];
      const lower = root.toLowerCase();
      if (lower === "variables" && child) {
        out.add(child.toLowerCase());
        continue;
      }
      if (CFML_SCOPES.has(lower)) continue;
      out.add(lower);
    }
  };

  const collectFromText = (text: string): void => {
    const re = /#([^#]+)#/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) collectIdents(m[1]);
  };

  const visit = (ns: CFMLNode[]): void => {
    for (const n of ns) {
      if (n.type === "content") {
        collectFromText(n.text);
        continue;
      }
      if (n.type === "comment" || n.type === "script") continue;
      const openText = source.slice(
        n.openTagRange.start,
        n.openTagRange.end
      );
      collectFromText(openText);
      if (n.name === "cfif" || n.name === "cfelseif") {
        const cond = openText.match(
          /^<cf(?:if|elseif)\b\s*([\s\S]*?)\s*\/?>$/i
        );
        if (cond) collectIdents(cond[1]);
      } else {
        for (const key of VIEW_REF_ATTRS) {
          const attr = n.attributes.get(key);
          if (attr && !attr.hasInterpolation) collectIdents(attr.value);
        }
      }
      visit(n.children);
    }
  };

  visit(nodes);
  return out;
}

function emitNode(
  node: CFMLNode,
  ctx: EmitContext,
  lines: string[]
): void {
  if (node.type === "comment") {
    emitComment(node, ctx, lines);
    return;
  }
  if (node.type === "content") {
    emitContent(node, ctx, lines);
    return;
  }
  if (node.type === "script") {
    emitScript(node, ctx, lines);
    return;
  }
  emitTag(node, ctx, lines);
}

function emitComment(
  node: CommentNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const inner = node.text
    .replace(/^<!---/, "")
    .replace(/--->$/, "")
    .trim();
  if (inner.length === 0) {
    lines.push("");
    return;
  }
  if (!inner.includes("\n")) {
    lines.push(`${ctx.indent}// ${inner}`);
  } else {
    lines.push(`${ctx.indent}/*`);
    for (const l of inner.split("\n")) {
      lines.push(`${ctx.indent} * ${l.trim()}`);
    }
    lines.push(`${ctx.indent} */`);
  }
}

function emitContent(
  node: ContentNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const text = node.text;
  if (text.trim().length === 0) {
    const newlines = (text.match(/\n/g) ?? []).length;
    if (newlines >= 2) lines.push("");
    return;
  }
  ctx.todos.push({ tag: "stray-text", raw: text.trim() });
  lines.push(
    `${ctx.indent}// TODO: manual conversion needed for stray text in handler region`
  );
  for (const l of text.trim().split("\n")) {
    lines.push(`${ctx.indent}// > ${l}`);
  }
}

function emitScript(
  node: ScriptNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const body = dedentReindent(node.body, ctx.indent);
  for (const l of body.split("\n")) {
    lines.push(l);
  }
  ctx.tagsConverted.n++;
}

function emitTag(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const name = node.name.toLowerCase();
  const handler = TAG_HANDLERS[name];
  if (handler) {
    handler(node, ctx, lines);
    ctx.tagsConverted.n++;
    return;
  }
  emitTodoTag(node, ctx, lines);
}

const TAG_HANDLERS: Record<
  string,
  (node: TagNode, ctx: EmitContext, lines: string[]) => void
> = {
  cfset: emitCfset,
  cfif: emitCfif,
  cfloop: emitCfloop,
  cfquery: emitCfquery,
  cfoutput: emitCfoutputAsLogic,
  cfparam: emitCfparam,
  cfinclude: emitCfinclude,
  cfdump: emitCfdump,
  cfabort: emitCfabort,
  cflocation: emitCflocation,
  cftry: emitCftry,
  cfswitch: emitCfswitch,
  cffunction: emitCffunction,
  cfreturn: emitCfreturn,
  cfsavecontent: emitCfsavecontent,
  cfheader: emitCfheader,
  cfcontent: emitCfcontent,
  cfmail: emitCfmail,
  cfthrow: emitCfthrow,
  cfrethrow: emitCfrethrow,
  cfbreak: emitCfbreak,
  cfcontinue: emitCfcontinue,
  cfsilent: emitCfsilent,
  cflog: emitCflog,
  cflock: emitCflock,
  cfstoredproc: emitCfstoredproc,
  cfprocparam: emitCfprocparam,
  cfprocresult: emitCfprocresult,
  cftransaction: emitCftransaction
};

function emitCfset(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const raw = ctx.source.slice(
    node.openTagRange.start,
    node.openTagRange.end
  );
  const m = raw.match(/^<cfset\s+([\s\S]*?)\s*\/?>$/i);
  const expr = m ? m[1].trim() : "";
  if (expr.length === 0) return;
  lines.push(`${ctx.indent}${expr};`);
}

function emitCfif(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const branches = splitIfBranches(node, ctx.source);
  branches.forEach((b, i) => {
    const head =
      i === 0
        ? `if (${b.condition ?? "true"}) {`
        : b.kind === "elseif"
          ? `} else if (${b.condition ?? "true"}) {`
          : `} else {`;
    if (i === 0) lines.push(`${ctx.indent}${head}`);
    else lines.push(`${ctx.indent}${head}`);
    const inner: EmitContext = {
      ...ctx,
      indent: ctx.indent + ctx.tabUnit
    };
    for (const c of b.children) emitNode(c, inner, lines);
  });
  lines.push(`${ctx.indent}}`);
}

interface IfBranch {
  kind: "if" | "elseif" | "else";
  condition?: string;
  children: CFMLNode[];
}

function splitIfBranches(node: TagNode, source: string): IfBranch[] {
  const branches: IfBranch[] = [];
  let cur: IfBranch = {
    kind: "if",
    condition: extractRawCondition(node, source),
    children: []
  };
  for (const child of node.children) {
    if (
      child.type === "tag" &&
      (child.name === "cfelseif" || child.name === "cfelse")
    ) {
      branches.push(cur);
      cur = {
        kind: child.name === "cfelseif" ? "elseif" : "else",
        condition:
          child.name === "cfelseif"
            ? extractRawCondition(child, source)
            : undefined,
        children: []
      };
      continue;
    }
    cur.children.push(child);
  }
  branches.push(cur);
  return branches;
}

function extractRawCondition(tag: TagNode, source: string): string {
  const raw = source.slice(tag.openTagRange.start, tag.openTagRange.end);
  const m = raw.match(/^<cf(?:if|elseif)\b\s*([\s\S]*?)\s*\/?>$/i);
  return m ? m[1].trim() : "";
}

function emitCfloop(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const attrs = node.attributes;
  const indexAttr = attrs.get("index") ?? attrs.get("item");
  const indexName = indexAttr?.value;
  const inner: EmitContext = {
    ...ctx,
    indent: ctx.indent + ctx.tabUnit
  };
  let header: string | undefined;
  if (attrs.has("array") && indexName) {
    const arr = unwrapAttr(attrs.get("array")!);
    header = `for (var ${indexName} in ${arr}) {`;
  } else if (attrs.has("collection") && indexName) {
    const col = unwrapAttr(attrs.get("collection")!);
    header = `for (var ${indexName} in ${col}) {`;
  } else if (attrs.has("list") && indexName) {
    const list = unwrapAttr(attrs.get("list")!);
    const sepAttr = attrs.get("delimiters");
    const sep = sepAttr ? `, ${quoteCfml(unwrapAttr(sepAttr))}` : "";
    header = `for (var ${indexName} in listToArray(${list}${sep})) {`;
  } else if (attrs.has("condition")) {
    const cond = unwrapAttr(attrs.get("condition")!);
    header = `while (${cond}) {`;
  } else if (
    attrs.has("from") &&
    attrs.has("to") &&
    indexName &&
    !attrs.has("step")
  ) {
    const from = unwrapAttr(attrs.get("from")!);
    const to = unwrapAttr(attrs.get("to")!);
    header = `for (var ${indexName} = ${from}; ${indexName} <= ${to}; ${indexName}++) {`;
  } else {
    const parts: string[] = [];
    for (const [k, v] of attrs) {
      parts.push(`${k}=${v.raw}`);
    }
    header = `cfloop(${parts.join(", ")}) {`;
  }
  lines.push(`${ctx.indent}${header}`);
  for (const c of node.children) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function emitCfquery(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const replacement = ctx.cfqueryReplacements.get(node.range.start);
  if (!replacement) {
    lines.push(
      `${ctx.indent}// TODO: <cfquery> at offset ${node.range.start} not converted`
    );
    return;
  }
  if (typeof replacement !== "string") {
    const name = node.attributes.get("name")?.value ?? "(unnamed)";
    ctx.todos.push({
      tag: "cfquery-skip",
      raw: `${name}: ${replacement.skipReason}`
    });
    lines.push(
      `${ctx.indent}// TODO: cfquery "${name}" not converted: ${replacement.skipReason}`
    );
    const raw = ctx.source.slice(node.range.start, node.range.end);
    for (const l of raw.split("\n")) {
      lines.push(`${ctx.indent}// > ${l}`);
    }
    return;
  }
  const stripped = stripCfscriptWrapper(replacement);
  const reindented = dedentReindent(stripped, ctx.indent);
  for (const l of reindented.split("\n")) lines.push(l);
}

function stripCfscriptWrapper(text: string): string {
  let out = text;
  out = out.replace(/^[ \t]*<cfscript>\r?\n?/, "");
  out = out.replace(/\r?\n?[ \t]*<\/cfscript>\s*$/, "");
  return out;
}

function emitCfoutputAsLogic(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  for (const c of node.children) emitNode(c, ctx, lines);
}

function emitCfparam(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}param ${parts.join(" ")};`);
}

function emitCfinclude(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const tmpl = node.attributes.get("template")?.value ?? "?";
  ctx.todos.push({ tag: "cfinclude", raw: tmpl });
  lines.push(
    `${ctx.indent}// TODO: manual conversion needed for <cfinclude template="${tmpl}">`
  );
  lines.push(
    `${ctx.indent}// (cfinclude often signals mixed concerns; consider extracting to a service or view fragment)`
  );
}

function emitCfdump(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}writeDump(${parts.join(", ")});`);
}

function emitCfabort(
  _node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  lines.push(`${ctx.indent}abort;`);
}

function emitCflocation(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}relocate(${parts.join(", ")});`);
}

function emitCftry(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  lines.push(`${ctx.indent}try {`);
  const inner: EmitContext = {
    ...ctx,
    indent: ctx.indent + ctx.tabUnit
  };
  const tryChildren: CFMLNode[] = [];
  const catches: TagNode[] = [];
  let finallyNode: TagNode | undefined;
  for (const c of node.children) {
    if (c.type === "tag" && c.name === "cfcatch") {
      catches.push(c);
    } else if (c.type === "tag" && c.name === "cffinally") {
      finallyNode = c;
    } else {
      tryChildren.push(c);
    }
  }
  for (const c of tryChildren) emitNode(c, inner, lines);
  for (const cc of catches) {
    const typ = cc.attributes.get("type")?.value ?? "any";
    lines.push(`${ctx.indent}} catch (${typ} e) {`);
    for (const cn of cc.children) emitNode(cn, inner, lines);
  }
  if (finallyNode) {
    lines.push(`${ctx.indent}} finally {`);
    for (const cn of finallyNode.children) emitNode(cn, inner, lines);
  }
  lines.push(`${ctx.indent}}`);
}

function emitCfswitch(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const expr = unwrapAttr(node.attributes.get("expression")!);
  lines.push(`${ctx.indent}switch (${expr}) {`);
  const caseIndent = ctx.indent + ctx.tabUnit;
  const bodyIndent = caseIndent + ctx.tabUnit;
  const inner: EmitContext = { ...ctx, indent: bodyIndent };
  for (const c of node.children) {
    if (c.type !== "tag") continue;
    if (c.name === "cfcase") {
      const v = unwrapAttr(c.attributes.get("value")!);
      lines.push(`${caseIndent}case ${quoteCfml(v)}: {`);
      for (const cn of c.children) emitNode(cn, inner, lines);
      lines.push(`${bodyIndent}break;`);
      lines.push(`${caseIndent}}`);
    } else if (c.name === "cfdefaultcase") {
      lines.push(`${caseIndent}default: {`);
      for (const cn of c.children) emitNode(cn, inner, lines);
      lines.push(`${caseIndent}}`);
    }
  }
  lines.push(`${ctx.indent}}`);
}

function emitCffunction(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const fname = node.attributes.get("name")?.value ?? "anon";
  const access = node.attributes.get("access")?.value;
  const returntype = node.attributes.get("returntype")?.value;
  const args: string[] = [];
  const bodyChildren: CFMLNode[] = [];
  for (const c of node.children) {
    if (c.type === "tag" && c.name === "cfargument") {
      const an = c.attributes.get("name")?.value ?? "arg";
      const at = c.attributes.get("type")?.value;
      const ad = c.attributes.get("default");
      const required = c.attributes.get("required")?.value;
      let part = "";
      if (required && /^(true|yes|1)$/i.test(required)) part += "required ";
      if (at) part += `${at} `;
      part += an;
      if (ad) part += `=${formatAttrValue(ad)}`;
      args.push(part.trim());
    } else {
      bodyChildren.push(c);
    }
  }
  const headerParts: string[] = [];
  if (access) headerParts.push(access);
  if (returntype) headerParts.push(returntype);
  headerParts.push(`function ${fname}(${args.join(", ")})`);
  lines.push(`${ctx.indent}${headerParts.join(" ")} {`);
  const inner: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  for (const c of bodyChildren) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function emitCfreturn(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const raw = ctx.source.slice(
    node.openTagRange.start,
    node.openTagRange.end
  );
  const m = raw.match(/^<cfreturn\s*([\s\S]*?)\s*\/?>$/i);
  const expr = m ? m[1].trim() : "";
  if (expr.length === 0) lines.push(`${ctx.indent}return;`);
  else lines.push(`${ctx.indent}return ${expr};`);
}

function emitCfsavecontent(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const v = node.attributes.get("variable")?.value ?? "out";
  lines.push(`${ctx.indent}savecontent variable="${v}" {`);
  const inner: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  for (const c of node.children) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function emitCfheader(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}cfheader(${parts.join(", ")});`);
}

function emitCfcontent(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}cfcontent(${parts.join(", ")});`);
}

function emitCfmail(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}cfmail(${parts.join(", ")}) {`);
  const inner: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  for (const c of node.children) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function emitCfthrow(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}throw(${parts.join(", ")});`);
}

function emitCfrethrow(
  _node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  lines.push(`${ctx.indent}rethrow;`);
}

function emitCfbreak(
  _node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  lines.push(`${ctx.indent}break;`);
}

function emitCfcontinue(
  _node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  lines.push(`${ctx.indent}continue;`);
}

function emitCfsilent(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  for (const c of node.children) emitNode(c, ctx, lines);
}

function emitCflog(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}cflog(${parts.join(", ")});`);
}

function emitCflock(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}cflock(${parts.join(", ")}) {`);
  const inner: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  for (const c of node.children) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function emitCfstoredproc(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  lines.push(`${ctx.indent}cfstoredproc(${parts.join(", ")}) {`);
  const inner: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  for (const c of node.children) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function emitCfprocparam(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    if (k === "variable") {
      parts.push(`${k}=${formatScopedNameAttr(v.value, ctx.modes)}`);
    } else {
      parts.push(`${k}=${formatAttrValue(v)}`);
    }
  }
  lines.push(`${ctx.indent}cfprocparam(${parts.join(", ")});`);
}

function emitCfprocresult(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    if (k === "name") {
      parts.push(`${k}=${formatScopedNameAttr(v.value, ctx.modes)}`);
    } else {
      parts.push(`${k}=${formatAttrValue(v)}`);
    }
  }
  lines.push(`${ctx.indent}cfprocresult(${parts.join(", ")});`);
}

function emitCftransaction(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  const parts: string[] = [];
  for (const [k, v] of node.attributes) {
    parts.push(`${k}=${formatAttrValue(v)}`);
  }
  const header =
    parts.length > 0 ? `transaction ${parts.join(" ")} {` : `transaction {`;
  lines.push(`${ctx.indent}${header}`);
  const inner: EmitContext = { ...ctx, indent: ctx.indent + ctx.tabUnit };
  for (const c of node.children) emitNode(c, inner, lines);
  lines.push(`${ctx.indent}}`);
}

function formatScopedNameAttr(
  rawName: string,
  modes: Map<string, "var" | "prc" | "local">
): string {
  if (!/^[A-Za-z_]\w*$/.test(rawName)) return quoteCfml(rawName);
  const mode = modes.get(rawName.toLowerCase());
  if (mode === "prc") return quoteCfml(`prc.${rawName}`);
  if (mode === "local") return quoteCfml(`local.${rawName}`);
  return quoteCfml(rawName);
}

function emitTodoTag(
  node: TagNode,
  ctx: EmitContext,
  lines: string[]
): void {
  ctx.todos.push({ tag: node.name, raw: snippetOf(ctx.source, node) });
  lines.push(
    `${ctx.indent}// TODO: manual conversion needed for <${node.name}>`
  );
  const raw = ctx.source.slice(node.range.start, node.range.end);
  for (const l of raw.split("\n")) {
    lines.push(`${ctx.indent}// > ${l}`);
  }
}

function snippetOf(source: string, node: TagNode): string {
  const raw = source.slice(node.range.start, node.range.end);
  return raw.length > 80 ? raw.slice(0, 80) + "…" : raw;
}

function unwrapAttr(attr: AttributeValue): string {
  const v = attr.value;
  const m = v.match(/^#([\s\S]+)#$/);
  if (m && !m[1].includes("#")) return m[1];
  if (attr.hasInterpolation) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return quoteCfml(v);
}

function formatAttrValue(attr: AttributeValue): string {
  const v = attr.value;
  if (attr.hasInterpolation) {
    const m = v.match(/^#([\s\S]+)#$/);
    if (m && !m[1].includes("#")) return m[1];
    return `"${v.replace(/"/g, '""')}"`;
  }
  return quoteCfml(v);
}

function quoteCfml(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function dedentReindent(text: string, newIndent: string): string {
  let lines = text.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return "";
  let minIndent = Infinity;
  for (const l of lines) {
    if (l.trim() === "") continue;
    const m = l.match(/^[\t ]*/);
    const n = m ? m[0].length : 0;
    if (n < minIndent) minIndent = n;
  }
  if (!isFinite(minIndent)) minIndent = 0;
  return lines
    .map((l) => (l.trim() === "" ? "" : newIndent + l.slice(minIndent)))
    .join("\n");
}

function trimBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function collectCandidateNames(
  nodes: CFMLNode[],
  source: string
): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string): void => {
    const key = name.toLowerCase();
    if (!out.has(key)) out.set(key, name);
  };
  const visit = (ns: CFMLNode[]): void => {
    for (const n of ns) {
      if (n.type !== "tag") continue;
      if (n.name === "cfset") {
        const raw = source.slice(n.openTagRange.start, n.openTagRange.end);
        const m = raw.match(/^<cfset\s+([\s\S]*?)\s*\/?>$/i);
        const expr = m ? m[1].trim() : "";
        const lhs = expr.match(/^(?:variables\.)?([A-Za-z_]\w*)/i);
        if (lhs) add(lhs[1]);
      } else if (n.name === "cfquery") {
        const name = n.attributes.get("name")?.value;
        if (name) add(name);
      } else if (n.name === "cfprocparam") {
        const v = n.attributes.get("variable")?.value;
        if (v && /^[A-Za-z_]\w*$/.test(v)) add(v);
      } else if (n.name === "cfprocresult") {
        const name = n.attributes.get("name")?.value;
        if (name && /^[A-Za-z_]\w*$/.test(name)) add(name);
      }
      if (n.children.length > 0 && n.name !== "cffunction") {
        visit(n.children);
      }
    }
  };
  visit(nodes);
  return out;
}

function computeModes(
  candidates: Map<string, string>,
  viewRef: Set<string>,
  scopeStyle: "var" | "local"
): Map<string, "var" | "prc" | "local"> {
  const out = new Map<string, "var" | "prc" | "local">();
  for (const lowerName of candidates.keys()) {
    if (viewRef.has(lowerName)) {
      out.set(lowerName, "prc");
    } else {
      out.set(lowerName, scopeStyle);
    }
  }
  return out;
}

interface Segment {
  kind: "live" | "string" | "comment";
  start: number;
  end: number;
}

function findSegments(body: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let liveStart = 0;
  const flush = (end: number): void => {
    if (end > liveStart) {
      out.push({ kind: "live", start: liveStart, end });
    }
  };
  while (i < body.length) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "/") {
      flush(i);
      const start = i;
      while (i < body.length && body[i] !== "\n") i++;
      out.push({ kind: "comment", start, end: i });
      liveStart = i;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      flush(i);
      const start = i;
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i++;
      if (i < body.length) i += 2;
      out.push({ kind: "comment", start, end: i });
      liveStart = i;
      continue;
    }
    if (c === '"' || c === "'") {
      flush(i);
      const start = i;
      const q = c;
      i++;
      while (i < body.length) {
        if (body[i] === q) {
          if (body[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push({ kind: "string", start, end: i });
      liveStart = i;
      continue;
    }
    i++;
  }
  flush(body.length);
  return out;
}

function applyScoping(
  body: string,
  modes: Map<string, "var" | "prc" | "local">
): string {
  if (modes.size === 0) return body;
  const segments = findSegments(body);
  const seenVarFirst = new Set<string>();
  const out: string[] = [];
  for (const seg of segments) {
    const chunk = body.slice(seg.start, seg.end);
    if (seg.kind !== "live") {
      out.push(chunk);
      continue;
    }
    out.push(rewriteLiveChunk(chunk, modes, seenVarFirst));
  }
  return out.join("");
}

function rewriteLiveChunk(
  chunk: string,
  modes: Map<string, "var" | "prc" | "local">,
  seenVarFirst: Set<string>
): string {
  let out = chunk.replace(
    /\bvariables\.([A-Za-z_]\w*)\b/gi,
    (full, name) => {
      const mode = modes.get(name.toLowerCase());
      if (!mode) return full;
      if (mode === "prc") return `prc.${name}`;
      if (mode === "local") return `local.${name}`;
      return name;
    }
  );

  out = out.replace(
    /(?<![.\w])([A-Za-z_]\w*)((?:\.\w+|\[[^\]\n]*\])*)\s*=(?!=)/g,
    (full, name, suffix) => {
      const lower = name.toLowerCase();
      const mode = modes.get(lower);
      if (!mode) return full;
      const eqMatchIdx = full.lastIndexOf("=");
      const ws = full.slice(name.length + suffix.length, eqMatchIdx);
      if (mode === "prc") return `prc.${name}${suffix}${ws}=`;
      if (mode === "local") return `local.${name}${suffix}${ws}=`;
      if (suffix.length === 0 && !seenVarFirst.has(lower)) {
        seenVarFirst.add(lower);
        return `var ${name}${ws}=`;
      }
      return `${name}${suffix}${ws}=`;
    }
  );

  out = out.replace(
    /(?<![.\w])([A-Za-z_]\w*)\b(?!\s*[(:=])/g,
    (full, name) => {
      const mode = modes.get(name.toLowerCase());
      if (!mode) return full;
      if (mode === "prc") return `prc.${name}`;
      if (mode === "local") return `local.${name}`;
      return full;
    }
  );

  return out;
}

// Rebuild the view text from its parsed nodes, qualifying references to
// handler variables that were rescoped to `prc` so the view still resolves
// them. Raw HTML is copied verbatim; only CFML expressions — #...#
// interpolations, <cfif> conditions, and variable-bearing attributes — are
// rewritten.
function rewriteViewSource(
  nodes: CFMLNode[],
  source: string,
  prcNames: Set<string>
): string {
  const emit = (node: CFMLNode): string => {
    if (node.type === "content") {
      return rewriteInterpolations(node.text, prcNames);
    }
    if (node.type === "comment" || node.type === "script") {
      return source.slice(node.range.start, node.range.end);
    }
    const openText = source.slice(
      node.openTagRange.start,
      node.openTagRange.end
    );
    const open = rewriteViewTagOpen(openText, node, prcNames);
    const body = node.children.map(emit).join("");
    const close = node.closeTagRange
      ? source.slice(node.closeTagRange.start, node.closeTagRange.end)
      : "";
    return open + body + close;
  };
  return nodes.map(emit).join("");
}

// Qualify the bare identifier references in one CFML expression.
function rewriteExprIdents(expr: string, prcNames: Set<string>): string {
  let r = expr.replace(
    /\bvariables\.([A-Za-z_]\w*)\b/gi,
    (m: string, name: string) =>
      prcNames.has(name.toLowerCase()) ? `prc.${name}` : m
  );
  r = r.replace(
    /(?<![.\w])([A-Za-z_]\w*)\b(?!\s*\()/g,
    (m: string, name: string) =>
      prcNames.has(name.toLowerCase()) ? `prc.${name}` : m
  );
  return r;
}

// Rewrite every #...# interpolation block in a run of view text.
function rewriteInterpolations(text: string, prcNames: Set<string>): string {
  return text.replace(
    /#([^#]+)#/g,
    (_full, expr: string) => `#${rewriteExprIdents(expr, prcNames)}#`
  );
}

function rewriteViewTagOpen(
  openText: string,
  node: TagNode,
  prcNames: Set<string>
): string {
  const out = rewriteInterpolations(openText, prcNames);
  if (node.name === "cfif" || node.name === "cfelseif") {
    return out.replace(
      /^(<cf(?:if|elseif)\b\s*)([\s\S]*?)(\s*\/?>)$/i,
      (_full, head: string, cond: string, tail: string) =>
        head + rewriteExprIdents(cond, prcNames) + tail
    );
  }
  // query/array/collection/condition attributes hold variable references.
  return out.replace(
    /\b(query|array|collection|condition)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>/]+)/gi,
    (full, name: string, eq: string, val: string) => {
      if (val.includes("#")) return full;
      const q = val[0] === '"' || val[0] === "'" ? val[0] : "";
      const inner = q ? val.slice(1, -1) : val;
      return `${name}${eq}${q}${rewriteExprIdents(inner, prcNames)}${q}`;
    }
  );
}

export interface MergeHandlerResult {
  output: string;
  inserted: boolean;
  conflict?: string;
}

export function buildHandlerFile(
  body: string,
  setViewCall: string | undefined,
  actionName: string,
  tabUnit: string
): string {
  const trimmedBody = body.replace(/\s+$/, "");
  const fnLines: string[] = [];
  fnLines.push("");
  fnLines.push(
    `${tabUnit}function ${actionName}( event, rc, prc ) {`
  );
  if (trimmedBody.length > 0) {
    fnLines.push(trimmedBody);
  }
  if (setViewCall) {
    if (trimmedBody.length > 0) fnLines.push("");
    fnLines.push(`${tabUnit}${tabUnit}${setViewCall}`);
  }
  fnLines.push(`${tabUnit}}`);
  fnLines.push("");
  return `component {\n${fnLines.join("\n")}\n}\n`;
}

export function mergeIntoExistingHandler(
  existing: string,
  body: string,
  setViewCall: string | undefined,
  actionName: string,
  tabUnit: string
): MergeHandlerResult {
  const compOpen = existing.match(/\bcomponent\b[^{]*\{/);
  if (!compOpen || compOpen.index === undefined) {
    return {
      output: existing,
      inserted: false,
      conflict:
        "could not find a component { ... } block in the existing handler"
    };
  }
  const fnRe = new RegExp(
    `\\bfunction\\s+${escapeRegex(actionName)}\\s*\\(`,
    "i"
  );
  if (fnRe.test(existing)) {
    return {
      output: existing,
      inserted: false,
      conflict: `function ${actionName} already exists in handler`
    };
  }
  const closeBrace = findMatchingBrace(
    existing,
    compOpen.index + compOpen[0].length - 1
  );
  if (closeBrace === -1) {
    return {
      output: existing,
      inserted: false,
      conflict: "could not find component closing brace"
    };
  }
  const trimmedBody = body.replace(/\s+$/, "");
  const fnLines: string[] = [];
  fnLines.push("");
  fnLines.push(
    `${tabUnit}function ${actionName}( event, rc, prc ) {`
  );
  if (trimmedBody.length > 0) fnLines.push(trimmedBody);
  if (setViewCall) {
    if (trimmedBody.length > 0) fnLines.push("");
    fnLines.push(`${tabUnit}${tabUnit}${setViewCall}`);
  }
  fnLines.push(`${tabUnit}}`);
  const insertion = fnLines.join("\n") + "\n";
  let beforeClose = existing.slice(0, closeBrace);
  beforeClose = beforeClose.replace(/\s+$/, "\n");
  const afterClose = existing.slice(closeBrace);
  const output = beforeClose + insertion + afterClose;
  return { output, inserted: true };
}

function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < source.length) {
        if (source[i] === q) {
          if (source[i + 1] === q) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      if (i < source.length) i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

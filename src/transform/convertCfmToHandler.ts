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
  extraSafeBuiltInFunctions?: string[];
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

const VIEW_LIKE_TAGS = new Set(["cfoutput"]);

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
    defaultDatasourcePatterns: options.defaultDatasourcePatterns,
    extraSafeBuiltInFunctions: options.extraSafeBuiltInFunctions
  };

  const doc = parse(source);
  const analysis = analyze(doc);

  const cfqueryReplacements = new Map<
    number,
    string | { skipReason: string }
  >();
  const querySkipped: Array<{ name: string; reason: string }> = [];
  for (const q of analysis.queries) {
    const skip = shouldSkipTransform(q, transformOpts);
    if (skip) {
      cfqueryReplacements.set(q.range.start, { skipReason: skip.reason });
      querySkipped.push({ name: q.name, reason: skip.reason });
      continue;
    }
    const t = transformQuery(q, source, transformOpts);
    cfqueryReplacements.set(q.range.start, t.replacement);
  }

  const split = splitHandlerView(doc.children);
  const viewSource = sliceNodes(source, split.viewNodes);
  const viewReferenced = collectViewReferenced(viewSource);

  const candidates = collectCandidateNames(split.handlerNodes, source);
  const modes = computeModes(candidates, viewReferenced, scopeStyle);

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
    modes
  };

  const lines: string[] = [];
  for (const node of split.handlerNodes) {
    emitNode(node, ctx, lines);
  }

  const rawBody = lines.join("\n");
  const trimmed = trimBlankRuns(rawBody);
  const rewritten = applyScoping(trimmed, modes);

  const hasView = split.viewNodes.length > 0 && viewSource.trim().length > 0;
  const setViewCall = hasView
    ? `event.setView( "${options.viewPath}" );`
    : undefined;

  let viewBody = "";
  if (hasView) {
    viewBody = rewriteViewSource(viewSource, viewReferenced);
  }

  const rescoped: RescopedVar[] = [];
  for (const [lowerName, mode] of modes) {
    const display = candidates.get(lowerName) ?? lowerName;
    rescoped.push({ name: display, mode });
  }

  return {
    handlerBody: rewritten,
    hasView,
    viewBody,
    todos: ctx.todos,
    tagsConverted: ctx.tagsConverted.n,
    rescoped,
    setViewCall,
    querySkipped
  };
}

interface SplitResult {
  handlerNodes: CFMLNode[];
  viewNodes: CFMLNode[];
}

function splitHandlerView(children: CFMLNode[]): SplitResult {
  let i = children.length;
  while (i > 0) {
    const node = children[i - 1];
    if (!isViewLike(node)) break;
    i--;
  }
  while (i > 0) {
    const node = children[i - 1];
    if (node.type === "comment") {
      i--;
      continue;
    }
    if (node.type === "content" && node.text.trim().length === 0) {
      i--;
      continue;
    }
    break;
  }
  return {
    handlerNodes: children.slice(0, i),
    viewNodes: children.slice(i)
  };
}

function isViewLike(node: CFMLNode): boolean {
  if (node.type === "content") return true;
  if (node.type === "comment") return true;
  if (node.type === "tag" && VIEW_LIKE_TAGS.has(node.name)) {
    return !cfoutputContainsLogic(node);
  }
  return false;
}

function cfoutputContainsLogic(tag: TagNode): boolean {
  for (const child of tag.children) {
    if (child.type === "tag") {
      if (
        child.name === "cfset" ||
        child.name === "cfquery" ||
        child.name === "cfif" ||
        child.name === "cfloop" ||
        child.name === "cflocation"
      ) {
        return true;
      }
    }
  }
  return false;
}

function sliceNodes(source: string, nodes: CFMLNode[]): string {
  if (nodes.length === 0) return "";
  const start = nodes[0].range.start;
  const end = nodes[nodes.length - 1].range.end;
  return source.slice(start, end);
}

function collectViewReferenced(viewSource: string): Set<string> {
  const out = new Set<string>();
  if (viewSource.length === 0) return out;
  const re = /#([^#]+)#/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(viewSource)) !== null) {
    const inner = m[1];
    const idRe = /(^|[^.\w])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(inner)) !== null) {
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
  }
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

function rewriteViewSource(
  viewSource: string,
  viewRef: Set<string>
): string {
  if (viewRef.size === 0) return viewSource;
  return viewSource.replace(/#([^#]+)#/g, (_full, expr) => {
    let r = expr.replace(
      /\bvariables\.([A-Za-z_]\w*)\b/gi,
      (m: string, name: string) =>
        viewRef.has(name.toLowerCase()) ? `prc.${name}` : m
    );
    r = r.replace(
      /(?<![.\w])([A-Za-z_]\w*)\b(?!\s*\()/g,
      (m: string, name: string) =>
        viewRef.has(name.toLowerCase()) ? `prc.${name}` : m
    );
    return `#${r}#`;
  });
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

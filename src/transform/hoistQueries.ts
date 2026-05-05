import type {
  CFMLDocument,
  CFMLNode,
  Range,
  ScriptNode,
  TagNode
} from "../parser/ast";
import { parse } from "../parser/parse";

const HOIST_MARKER = "Hoisted by cfml-refactor";
const NO_HOIST_RE = /@cfml-refactor:no-hoist\b/i;

const SAFE_SCOPES = new Set([
  "url",
  "form",
  "rc",
  "arguments",
  "session",
  "application",
  "cgi",
  "server",
  "cookie",
  "request"
]);

const KEYWORDS = new Set([
  "null",
  "true",
  "false",
  "and",
  "or",
  "not",
  "xor",
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "is",
  "isnot",
  "contains",
  "like",
  "mod",
  "queryexecute"
]);

const PARAM_PROPERTY_KEYS = new Set([
  "value",
  "cfsqltype",
  "null",
  "list",
  "separator",
  "maxlength",
  "scale",
  "datasource",
  "username",
  "password",
  "timeout",
  "result",
  "cachedwithin",
  "cachedafter",
  "maxrows",
  "blockfactor"
]);

export type Eligibility =
  | "hoistable"
  | "conditionally-hoistable"
  | "loop-hoistable"
  | "not-hoistable";

export interface ClassifiedCall {
  prcVar: string;
  statementRange: Range;
  identifierPaths: string[];
  scriptNode: ScriptNode;
  ancestorChain: TagNode[];
  ancestorCfif?: TagNode;
  outermostLoop?: TagNode;
  cfifPathInLoop: TagNode[];
  noHoistMarker: boolean;
  eligibility: Eligibility;
  reason?: string;
  branchCondition?: string;
}

export interface HoistResult {
  output: string;
  hoisted: ClassifiedCall[];
  conditionallyHoisted: ClassifiedCall[];
  loopHoisted: ClassifiedCall[];
  skipped: ClassifiedCall[];
  warnings: string[];
  error?: string;
  noChange?: boolean;
}

interface HoistOptions {
  tabUnit?: string;
  today?: string;
}

export function hoistDocument(
  source: string,
  opts: HoistOptions = {}
): HoistResult {
  const tabUnit = opts.tabUnit ?? "    ";
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const doc = parse(source);
  const inputCounts = countTagsInDoc(doc);
  if (inputCounts.cfqueryNonQoQ > 0) {
    return {
      output: source,
      hoisted: [],
      conditionallyHoisted: [],
      loopHoisted: [],
      skipped: [],
      warnings: [],
      error:
        "Found <cfquery> tags — run Phase 2 (Convert Queries In Place) first."
    };
  }

  const calls = scanDocument(doc, source);

  const candidates = new Set<string>();
  for (const c of calls) {
    if (isStructurallyHoistable(c)) candidates.add(c.prcVar);
  }
  resolveDependencies(calls, candidates);

  const seenNames = new Set<string>();
  for (const c of calls) {
    if (candidates.has(c.prcVar)) {
      if (seenNames.has(c.prcVar)) candidates.delete(c.prcVar);
      seenNames.add(c.prcVar);
    }
  }

  for (const c of calls) classify(c, candidates, source);

  const hoistable = calls.filter((c) => c.eligibility === "hoistable");
  const condHoistable = calls.filter(
    (c) => c.eligibility === "conditionally-hoistable"
  );
  const loopHoistable = calls.filter(
    (c) => c.eligibility === "loop-hoistable"
  );
  const skippedAll = calls.filter((c) => c.eligibility === "not-hoistable");
  const skippedReportable = skippedAll.filter((c) => !c.noHoistMarker);

  const orderable = [...hoistable, ...condHoistable];
  const ordered = topoSort(
    orderable,
    new Set(orderable.map((c) => c.prcVar))
  );
  if (ordered === undefined) {
    return {
      output: source,
      hoisted: [],
      conditionallyHoisted: [],
      loopHoisted: [],
      skipped: skippedAll,
      warnings: [],
      error: "Dependency cycle detected among hoistable queries — aborting."
    };
  }

  const plan = planInsertion(doc, source);
  const existingNames = new Set<string>();
  const existingSkipped = new Set<string>();
  if (plan.kind === "merge") {
    for (const n of extractExistingHoistedNames(plan.targetBody)) {
      existingNames.add(n);
    }
    for (const n of extractExistingSkippedNames(plan.targetBody)) {
      existingSkipped.add(n);
    }
  }
  const toEmit = ordered.filter((c) => !existingNames.has(c.prcVar));
  const toEmitSkipped = skippedReportable.filter(
    (c) => !existingSkipped.has(c.prcVar)
  );
  const existingLoopHoisted = plan.kind === "merge"
    ? extractExistingLoopHoistedNames(plan.targetBody)
    : new Set<string>();
  const toEmitLoop = loopHoistable.filter(
    (c) => !existingLoopHoisted.has(c.prcVar)
  );

  if (toEmit.length === 0 && toEmitSkipped.length === 0 && toEmitLoop.length === 0) {
    return {
      output: source,
      hoisted: hoistable,
      conditionallyHoisted: condHoistable,
      loopHoisted: loopHoistable,
      skipped: skippedAll,
      warnings: [],
      noChange: true
    };
  }

  const output = applyHoist(
    source,
    toEmit,
    toEmitLoop,
    toEmitSkipped,
    plan,
    tabUnit,
    today
  );
  const safety = runSafetyChecks(source, output, calls);
  if (safety.error) {
    return {
      output: source,
      hoisted: [],
      conditionallyHoisted: [],
      loopHoisted: [],
      skipped: skippedAll,
      warnings: safety.warnings,
      error: safety.error
    };
  }

  return {
    output,
    hoisted: hoistable,
    conditionallyHoisted: condHoistable,
    loopHoisted: loopHoistable,
    skipped: skippedAll,
    warnings: safety.warnings
  };
}

interface RawCall {
  prcVar: string;
  statementRange: Range;
  identifierPaths: string[];
}

function scanDocument(doc: CFMLDocument, _source: string): ClassifiedCall[] {
  const out: ClassifiedCall[] = [];
  let pendingNoHoist = false;

  const visit = (nodes: CFMLNode[], chain: TagNode[]): void => {
    for (const node of nodes) {
      if (node.type === "comment") {
        if (NO_HOIST_RE.test(node.text)) pendingNoHoist = true;
        continue;
      }
      if (node.type === "content") {
        if (node.text.trim().length === 0) continue;
        pendingNoHoist = false;
        continue;
      }
      if (node.type === "script") {
        const scriptCalls = scanScriptForQueries(node);
        const noHoist = pendingNoHoist;
        const outermostLoop = chain.find((t) => t.name === "cfloop");
        const cfifPathInLoop = outermostLoop
          ? chain
              .slice(chain.indexOf(outermostLoop) + 1)
              .filter((t) => t.name === "cfif")
          : [];
        for (const raw of scriptCalls) {
          out.push({
            prcVar: raw.prcVar,
            statementRange: raw.statementRange,
            identifierPaths: raw.identifierPaths,
            scriptNode: node,
            ancestorChain: [...chain],
            ancestorCfif: chain.find((t) => t.name === "cfif"),
            outermostLoop,
            cfifPathInLoop,
            noHoistMarker: noHoist,
            eligibility: "not-hoistable"
          });
        }
        pendingNoHoist = false;
        continue;
      }
      pendingNoHoist = false;
      if (node.children.length > 0) {
        visit(node.children, [...chain, node]);
      }
    }
  };

  visit(doc.children, []);
  return out;
}

function scanScriptForQueries(script: ScriptNode): RawCall[] {
  const out: RawCall[] = [];
  const body = script.body;
  const base = script.bodyRange.start;
  let i = 0;
  const len = body.length;
  while (i < len) {
    const ch = body[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
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
    const stmtStart = i;
    const m = matchQueryExecute(body, i);
    if (m) {
      out.push({
        prcVar: m.prcVar,
        statementRange: { start: base + stmtStart, end: base + m.end },
        identifierPaths: m.identifierPaths
      });
      i = m.end;
      continue;
    }
    i++;
  }
  return out;
}

interface QExecMatch {
  end: number;
  prcVar: string;
  identifierPaths: string[];
}

function matchQueryExecute(body: string, start: number): QExecMatch | null {
  let i = start;
  if (body.slice(i, i + 4).toLowerCase() !== "prc.") return null;
  i += 4;
  const ns = i;
  while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
  if (i === ns) return null;
  const prcVar = body.slice(ns, i);
  i = skipSpaces(body, i);
  if (body[i] !== "=") return null;
  i++;
  i = skipSpaces(body, i);
  const KW = "queryExecute";
  if (body.slice(i, i + KW.length).toLowerCase() !== KW.toLowerCase()) {
    return null;
  }
  i += KW.length;
  i = skipSpaces(body, i);
  if (body[i] !== "(") return null;
  i++;
  const identifierPaths: string[] = [];
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
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const idStart = i;
      while (i < body.length && /[A-Za-z0-9_.]/.test(body[i])) i++;
      const idText = body.slice(idStart, i);
      let j = i;
      while (j < body.length && /[ \t]/.test(body[j])) j++;
      if (body[j] === ":") continue;
      const lower = idText.toLowerCase();
      if (KEYWORDS.has(lower)) continue;
      if (!idText.includes(".") && PARAM_PROPERTY_KEYS.has(lower)) continue;
      identifierPaths.push(idText);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      while (i < body.length && /[0-9.]/.test(body[i])) i++;
      continue;
    }
    i++;
  }
  i = skipSpaces(body, i);
  let end = i;
  if (body[i] === ";") end = i + 1;
  return { end, prcVar, identifierPaths };
}

function skipSpaces(body: string, i: number): number {
  while (i < body.length && /[ \t\r\n]/.test(body[i])) i++;
  return i;
}

function skipString(body: string, i: number): number {
  const quote = body[i];
  i++;
  while (i < body.length) {
    if (body[i] === quote) {
      if (body[i + 1] === quote) {
        i += 2;
        continue;
      }
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

function isStructurallyHoistable(c: ClassifiedCall): boolean {
  if (c.noHoistMarker) return false;
  for (const t of c.ancestorChain) {
    if (t.name === "cftry" || t.name === "cfcatch") return false;
  }
  return true;
}

function classify(
  c: ClassifiedCall,
  candidates: Set<string>,
  source: string
): void {
  if (c.noHoistMarker) {
    c.eligibility = "not-hoistable";
    c.reason = "marked @cfml-refactor:no-hoist";
    return;
  }
  let cfifCount = 0;
  for (const t of c.ancestorChain) {
    if (t.name === "cftry" || t.name === "cfcatch") {
      c.eligibility = "not-hoistable";
      c.reason = `inside <${t.name}>`;
      return;
    }
    if (t.name === "cfif") cfifCount++;
  }
  if (!candidates.has(c.prcVar)) {
    const dep = findUnsafeReference(
      c.identifierPaths,
      candidates,
      !!c.outermostLoop
    );
    c.eligibility = "not-hoistable";
    c.reason = dep ?? "depends on a non-hoistable variable";
    return;
  }
  if (c.outermostLoop) {
    for (const cfif of c.cfifPathInLoop) {
      const branchCond = findBranchConditionForCall(cfif, c, source);
      if (branchCond === undefined) {
        c.eligibility = "not-hoistable";
        c.reason = "could not extract <cfif> condition inside loop";
        return;
      }
    }
    c.eligibility = "loop-hoistable";
    return;
  }
  if (cfifCount > 1) {
    c.eligibility = "not-hoistable";
    c.reason = "nested inside more than one <cfif>";
    return;
  }
  if (cfifCount === 1) {
    const cfif = c.ancestorCfif!;
    const branchCond = findBranchConditionForCall(cfif, c, source);
    if (branchCond === undefined) {
      c.eligibility = "not-hoistable";
      c.reason = "could not extract <cfif> condition";
      return;
    }
    const condPaths = extractIdentifierPaths(branchCond);
    const dep = findUnsafeReference(condPaths, candidates, false);
    if (dep) {
      c.eligibility = "not-hoistable";
      c.reason = `<cfif> condition ${dep}`;
      return;
    }
    c.eligibility = "conditionally-hoistable";
    c.branchCondition = branchCond;
    return;
  }
  c.eligibility = "hoistable";
}

function findUnsafeReference(
  paths: string[],
  candidates: Set<string>,
  relaxedForLoop: boolean
): string | undefined {
  for (const p of paths) {
    const segs = p.split(".");
    const root = segs[0].toLowerCase();
    if (SAFE_SCOPES.has(root)) continue;
    if (root === "prc") {
      if (segs.length < 2) return `references bare "prc"`;
      if (candidates.has(segs[1])) continue;
      if (relaxedForLoop) continue;
      return `depends on prc.${segs[1]} (not hoistable)`;
    }
    if (relaxedForLoop) continue;
    return `references unscoped variable "${p}"`;
  }
  return undefined;
}

function resolveDependencies(
  calls: ClassifiedCall[],
  candidates: Set<string>
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of calls) {
      if (!candidates.has(c.prcVar)) continue;
      if (findUnsafeReference(c.identifierPaths, candidates, !!c.outermostLoop)) {
        candidates.delete(c.prcVar);
        changed = true;
      }
    }
  }
}

function extractIdentifierPaths(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) i++;
      const idText = text.slice(start, i);
      const lower = idText.toLowerCase();
      if (KEYWORDS.has(lower)) continue;
      out.push(idText);
      continue;
    }
    i++;
  }
  return out;
}

function findBranchConditionForCall(
  cfif: TagNode,
  call: ClassifiedCall,
  source: string
): string | undefined {
  const branches = parseCfifBranches(cfif, source);
  for (const b of branches) {
    if (
      b.range.start <= call.statementRange.start &&
      call.statementRange.end <= b.range.end
    ) {
      if (b.kind === "else") return "true";
      return b.condition ?? undefined;
    }
  }
  return undefined;
}

interface RawBranch {
  kind: "if" | "elseif" | "else";
  condition?: string;
  range: Range;
}

function parseCfifBranches(cfif: TagNode, source: string): RawBranch[] {
  const branches: RawBranch[] = [];
  const ifCondition = extractCondition(cfif, source, "cfif");
  let curStart = cfif.openTagRange.end;
  let curKind: "if" | "elseif" | "else" = "if";
  let curCondition: string | undefined = ifCondition;
  for (const child of cfif.children) {
    if (
      child.type === "tag" &&
      (child.name === "cfelseif" || child.name === "cfelse")
    ) {
      branches.push({
        kind: curKind,
        condition: curCondition,
        range: { start: curStart, end: child.range.start }
      });
      if (child.name === "cfelseif") {
        curKind = "elseif";
        curCondition = extractCondition(child, source, "cfelseif");
      } else {
        curKind = "else";
        curCondition = undefined;
      }
      curStart = child.range.end;
    }
  }
  const endPos = cfif.closeTagRange ? cfif.closeTagRange.start : cfif.range.end;
  branches.push({
    kind: curKind,
    condition: curCondition,
    range: { start: curStart, end: endPos }
  });
  return branches;
}

function extractCondition(
  tag: TagNode,
  source: string,
  tagName: string
): string | undefined {
  const open = tag.openTagRange;
  const raw = source.slice(open.start, open.end);
  const re = new RegExp(`^<${tagName}\\b\\s*([\\s\\S]*?)\\s*/?>$`, "i");
  const m = raw.match(re);
  if (!m) return undefined;
  return m[1].trim();
}

interface InsertionPlan {
  kind: "insert" | "merge";
  insertOffset: number;
  targetBody: string;
  targetBodyEnd: number;
  scriptOpenIndent: string;
}

function planInsertion(doc: CFMLDocument, source: string): InsertionPlan {
  const top = doc.children;
  let lastSkippedEnd = 0;
  for (let i = 0; i < top.length; i++) {
    const node = top[i];
    if (node.type === "comment") {
      lastSkippedEnd = node.range.end;
      continue;
    }
    if (node.type === "content") {
      if (node.text.trim().length === 0) {
        lastSkippedEnd = node.range.end;
        continue;
      }
      break;
    }
    if (node.type === "tag") {
      const lname = node.name;
      if (lname === "cfsetting" || lname === "cfparam" || lname === "cfimport") {
        lastSkippedEnd = node.range.end;
        continue;
      }
      break;
    }
    if (node.type === "script") {
      const indent = leadingIndent(source, node.range.start);
      return {
        kind: "merge",
        insertOffset: node.bodyRange.end,
        targetBody: node.body,
        targetBodyEnd: node.bodyRange.end,
        scriptOpenIndent: indent
      };
    }
    break;
  }
  return {
    kind: "insert",
    insertOffset: lastSkippedEnd,
    targetBody: "",
    targetBodyEnd: lastSkippedEnd,
    scriptOpenIndent: ""
  };
}

function leadingIndent(source: string, pos: number): string {
  let lineStart = pos;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  let i = lineStart;
  while (i < pos && (source[i] === " " || source[i] === "\t")) i++;
  return source.slice(lineStart, i);
}

function extractExistingHoistedNames(body: string): string[] {
  if (!body.includes(HOIST_MARKER)) return [];
  const out: string[] = [];
  const re = /\bprc\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*queryExecute\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

function extractExistingSkippedNames(body: string): string[] {
  if (!body.includes(HOIST_MARKER)) return [];
  const out: string[] = [];
  const re = /\/\/\s*SKIPPED:\s*prc\.([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

function extractExistingLoopHoistedNames(body: string): Set<string> {
  const out = new Set<string>();
  if (!body.includes(HOIST_MARKER)) return out;
  const re = /\bvmRow\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*queryExecute\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

function topoSort(
  calls: ClassifiedCall[],
  candidates: Set<string>
): ClassifiedCall[] | undefined {
  const byName = new Map<string, ClassifiedCall>();
  for (const c of calls) byName.set(c.prcVar, c);
  const deps = new Map<string, Set<string>>();
  for (const c of calls) {
    const set = new Set<string>();
    for (const path of c.identifierPaths) {
      const segs = path.split(".");
      if (segs[0].toLowerCase() === "prc" && segs.length > 1) {
        const dep = segs[1];
        if (candidates.has(dep) && dep !== c.prcVar) set.add(dep);
      }
    }
    deps.set(c.prcVar, set);
  }
  const sourceOrder = new Map<string, number>();
  calls.forEach((c, idx) => sourceOrder.set(c.prcVar, idx));

  const result: ClassifiedCall[] = [];
  const state = new Map<string, "in" | "done">();
  const visit = (name: string): boolean => {
    const s = state.get(name);
    if (s === "done") return true;
    if (s === "in") return false;
    state.set(name, "in");
    const ds = Array.from(deps.get(name) ?? []).sort(
      (a, b) => (sourceOrder.get(a) ?? 0) - (sourceOrder.get(b) ?? 0)
    );
    for (const d of ds) {
      if (!visit(d)) return false;
    }
    state.set(name, "done");
    const node = byName.get(name);
    if (node) result.push(node);
    return true;
  };

  const orderedNames = [...byName.keys()].sort(
    (a, b) => (sourceOrder.get(a) ?? 0) - (sourceOrder.get(b) ?? 0)
  );
  for (const n of orderedNames) {
    if (!visit(n)) return undefined;
  }
  return result;
}

interface RemovalEdit {
  range: Range;
}

function applyHoist(
  source: string,
  toHoist: ClassifiedCall[],
  toLoopHoist: ClassifiedCall[],
  skipped: ClassifiedCall[],
  plan: InsertionPlan,
  tabUnit: string,
  today: string
): string {
  const baseIndent = plan.kind === "merge" ? plan.scriptOpenIndent + tabUnit : tabUnit;

  const blockBody = renderBlockBody(
    toHoist,
    toLoopHoist,
    skipped,
    source,
    baseIndent,
    tabUnit,
    today,
    plan
  );

  const removals = computeRemovals(toHoist, source);
  const markerEdits = computeMarkerInsertions(toHoist, source);

  const insertionEdit = buildInsertionEdit(plan, blockBody, source);

  const allEdits: Array<{ range: Range; replacement: string }> = [
    ...removals.map((r) => ({ range: r.range, replacement: "" })),
    ...markerEdits,
    insertionEdit
  ];

  allEdits.sort((a, b) => b.range.start - a.range.start);

  let out = source;
  for (const edit of allEdits) {
    out = out.slice(0, edit.range.start) + edit.replacement + out.slice(edit.range.end);
  }
  return collapseBlankRuns(out);
}

function buildInsertionEdit(
  plan: InsertionPlan,
  blockBody: string,
  source: string
): { range: Range; replacement: string } {
  if (plan.kind === "merge") {
    const at = plan.targetBodyEnd;
    const existing = plan.targetBody;
    let prefix = "";
    if (existing.trim().length > 0) {
      prefix = existing.endsWith("\n") ? "\n" : "\n\n";
    }
    return {
      range: { start: at, end: at },
      replacement: prefix + blockBody
    };
  }
  const at = plan.insertOffset;
  const indent = plan.scriptOpenIndent;
  let pre = "";
  if (at > 0 && source[at - 1] !== "\n") pre = "\n";
  let post = "\n";
  if (at < source.length && source[at] !== "\n") post = "\n\n";
  const block =
    pre +
    `${indent}<cfscript>\n` +
    blockBody +
    `${indent}</cfscript>` +
    post;
  return {
    range: { start: at, end: at },
    replacement: block
  };
}

function computeMarkerInsertions(
  toHoist: ClassifiedCall[],
  source: string
): Array<{ range: Range; replacement: string }> {
  const markedCfifs = new Set<TagNode>();
  for (const c of toHoist) {
    if (c.eligibility === "conditionally-hoistable" && c.ancestorCfif) {
      markedCfifs.add(c.ancestorCfif);
    }
  }
  const out: Array<{ range: Range; replacement: string }> = [];
  for (const cfif of markedCfifs) {
    const lineStart = lineStartOf(source, cfif.range.start);
    const indent = source.slice(lineStart, cfif.range.start);
    const prevLineStart = lineStart > 0
      ? lineStartOf(source, lineStart - 1)
      : 0;
    const lineAbove = source.slice(prevLineStart, lineStart);
    if (lineAbove.includes("Data fetched in hoisted block")) continue;
    out.push({
      range: { start: cfif.range.start, end: cfif.range.start },
      replacement: `<!--- Data fetched in hoisted block above --->\n${indent}`
    });
  }
  return out;
}

function lineStartOf(source: string, pos: number): number {
  let i = pos;
  while (i > 0 && source[i - 1] !== "\n") i--;
  return i;
}

function computeRemovals(
  toHoist: ClassifiedCall[],
  source: string
): RemovalEdit[] {
  const byScript = new Map<ScriptNode, ClassifiedCall[]>();
  for (const c of toHoist) {
    const list = byScript.get(c.scriptNode) ?? [];
    list.push(c);
    byScript.set(c.scriptNode, list);
  }
  const out: RemovalEdit[] = [];
  for (const [script, calls] of byScript) {
    if (canRemoveWholeScript(script, calls)) {
      out.push({ range: expandWholeScriptRange(script, source) });
    } else {
      for (const c of calls) {
        out.push({ range: expandStatementRange(c.statementRange, source) });
      }
    }
  }
  return out;
}

function canRemoveWholeScript(
  script: ScriptNode,
  hoisted: ClassifiedCall[]
): boolean {
  const body = script.body;
  let stripped = body;
  const sorted = [...hoisted].sort(
    (a, b) => b.statementRange.start - a.statementRange.start
  );
  for (const c of sorted) {
    const ls = c.statementRange.start - script.bodyRange.start;
    const le = c.statementRange.end - script.bodyRange.start;
    stripped = stripped.slice(0, ls) + stripped.slice(le);
  }
  const cleaned = stripped
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return cleaned.trim().length === 0;
}

function expandWholeScriptRange(script: ScriptNode, source: string): Range {
  let start = script.range.start;
  let end = script.range.end;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) {
    start--;
  }
  if (start > 0 && source[start - 1] === "\n") {
    start--;
    if (start > 0 && source[start - 1] === "\r") start--;
  }
  while (end < source.length && (source[end] === " " || source[end] === "\t")) {
    end++;
  }
  return { start, end };
}

function expandStatementRange(range: Range, source: string): Range {
  let start = range.start;
  let end = range.end;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) {
    start--;
  }
  while (end < source.length && (source[end] === " " || source[end] === "\t")) {
    end++;
  }
  if (end < source.length && source[end] === "\n") end++;
  return { start, end };
}

function renderBlockBody(
  hoisted: ClassifiedCall[],
  loopHoisted: ClassifiedCall[],
  skipped: ClassifiedCall[],
  source: string,
  baseIndent: string,
  tabUnit: string,
  today: string,
  plan: InsertionPlan
): string {
  const isMerge = plan.kind === "merge";
  const alreadyHasMarker = isMerge && plan.targetBody.includes(HOIST_MARKER);
  const existingHasViewModel =
    isMerge && /\bprc\.viewModel\s*=\s*\[\s*\]/.test(plan.targetBody);
  const lines: string[] = [];

  if (!alreadyHasMarker) {
    lines.push(`${baseIndent}// ===== View model =====`);
    lines.push(`${baseIndent}// ${HOIST_MARKER} on ${today}`);
    lines.push(`${baseIndent}// TODO: Move these to the handler`);
    if (hoisted.length > 0 || loopHoisted.length > 0 || skipped.length > 0) {
      lines.push("");
    }
  }

  const groups = groupConditional(hoisted);
  let firstGroup = true;
  for (const group of groups) {
    if (!firstGroup) lines.push("");
    firstGroup = false;
    if (group.kind === "plain") {
      for (const c of group.calls) {
        const stmt = renderStatement(c, source, baseIndent);
        for (const l of stmt.split("\n")) lines.push(l);
      }
    } else {
      lines.push(`${baseIndent}if (${group.condition}) {`);
      for (const c of group.calls) {
        const stmt = renderStatement(c, source, baseIndent + tabUnit);
        for (const l of stmt.split("\n")) lines.push(l);
      }
      lines.push(`${baseIndent}}`);
    }
  }

  if (loopHoisted.length > 0) {
    if (hoisted.length > 0 || !alreadyHasMarker) lines.push("");
    if (!existingHasViewModel) {
      lines.push(`${baseIndent}prc.viewModel = [];`);
    }
    const loopGroups = groupByOutermostLoop(loopHoisted);
    let firstLoopGroup = true;
    for (const group of loopGroups) {
      if (!firstLoopGroup || existingHasViewModel) lines.push("");
      firstLoopGroup = false;
      const loopLines = renderLoopGroup(group, source, baseIndent, tabUnit);
      for (const l of loopLines) lines.push(l);
    }
  }

  if (skipped.length > 0) {
    if (hoisted.length > 0 || loopHoisted.length > 0) lines.push("");
    for (const c of skipped) {
      const reason = c.reason ?? "not eligible";
      lines.push(`${baseIndent}// SKIPPED: prc.${c.prcVar} — ${reason}`);
    }
  }

  return lines.join("\n") + "\n";
}

interface LoopGroup {
  outermostLoop: TagNode;
  calls: ClassifiedCall[];
}

function groupByOutermostLoop(calls: ClassifiedCall[]): LoopGroup[] {
  const map = new Map<TagNode, ClassifiedCall[]>();
  for (const c of calls) {
    if (!c.outermostLoop) continue;
    const list = map.get(c.outermostLoop) ?? [];
    list.push(c);
    map.set(c.outermostLoop, list);
  }
  const out: LoopGroup[] = [];
  for (const [loop, list] of map) {
    list.sort((a, b) => a.statementRange.start - b.statementRange.start);
    out.push({ outermostLoop: loop, calls: list });
  }
  out.sort(
    (a, b) => a.outermostLoop.range.start - b.outermostLoop.range.start
  );
  return out;
}

function renderLoopGroup(
  group: LoopGroup,
  source: string,
  baseIndent: string,
  tabUnit: string
): string[] {
  const lines: string[] = [];
  const attrs = renderCfloopAttrs(group.outermostLoop);
  lines.push(`${baseIndent}cfloop(${attrs}) {`);
  const inner = baseIndent + tabUnit;
  lines.push(`${inner}var vmRow = {};`);

  const cfifGroups = groupLoopCallsByCfifPath(group.calls, source);
  for (const cg of cfifGroups) {
    const callLines = renderLoopCallEmissions(
      cg,
      source,
      inner,
      tabUnit
    );
    for (const l of callLines) lines.push(l);
  }

  lines.push(`${inner}arrayAppend(prc.viewModel, vmRow);`);
  lines.push(`${baseIndent}}`);
  return lines;
}

interface LoopCfifGroup {
  conditions: string[];
  calls: ClassifiedCall[];
}

function groupLoopCallsByCfifPath(
  calls: ClassifiedCall[],
  source: string
): LoopCfifGroup[] {
  const groups: LoopCfifGroup[] = [];
  const sortedCalls = [...calls].sort(
    (a, b) => a.statementRange.start - b.statementRange.start
  );
  for (const c of sortedCalls) {
    const conds: string[] = [];
    for (const cfif of c.cfifPathInLoop) {
      const cond = findBranchConditionForCall(cfif, c, source) ?? "true";
      conds.push(cond);
    }
    const last = groups[groups.length - 1];
    if (last && arraysEqual(last.conditions, conds)) {
      last.calls.push(c);
    } else {
      groups.push({ conditions: conds, calls: [c] });
    }
  }
  return groups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function renderLoopCallEmissions(
  group: LoopCfifGroup,
  source: string,
  indent: string,
  tabUnit: string
): string[] {
  const lines: string[] = [];
  let curIndent = indent;
  for (const cond of group.conditions) {
    lines.push(`${curIndent}if (${cond}) {`);
    curIndent += tabUnit;
  }
  for (const c of group.calls) {
    const stmt = renderLoopStatement(c, source, curIndent);
    for (const l of stmt.split("\n")) lines.push(l);
  }
  for (let i = 0; i < group.conditions.length; i++) {
    curIndent = curIndent.slice(0, curIndent.length - tabUnit.length);
    lines.push(`${curIndent}}`);
  }
  return lines;
}

function renderLoopStatement(
  c: ClassifiedCall,
  source: string,
  newIndent: string
): string {
  const text = source.slice(c.statementRange.start, c.statementRange.end);
  const replaced = text.replace(
    /^prc\.([A-Za-z_][A-Za-z0-9_]*)/,
    (_m, name) => `vmRow.${name}`
  );
  const originalLeading = leadingIndentBeforePos(source, c.statementRange.start);
  return reindent(replaced, newIndent, originalLeading);
}

function renderCfloopAttrs(loop: TagNode): string {
  const parts: string[] = [];
  for (const [name, attr] of loop.attributes) {
    if (attr.raw === "") {
      parts.push(name);
    } else {
      parts.push(`${name}=${attr.raw}`);
    }
  }
  return parts.join(", ");
}

interface HoistGroup {
  kind: "plain" | "conditional";
  calls: ClassifiedCall[];
  condition?: string;
}

function groupConditional(calls: ClassifiedCall[]): HoistGroup[] {
  const out: HoistGroup[] = [];
  let i = 0;
  while (i < calls.length) {
    const c = calls[i];
    if (c.eligibility === "hoistable") {
      const g: HoistGroup = { kind: "plain", calls: [] };
      while (i < calls.length && calls[i].eligibility === "hoistable") {
        g.calls.push(calls[i]);
        i++;
      }
      out.push(g);
    } else {
      const cfif = c.ancestorCfif;
      const cond = c.branchCondition ?? "true";
      const g: HoistGroup = {
        kind: "conditional",
        calls: [],
        condition: cond
      };
      while (
        i < calls.length &&
        calls[i].eligibility === "conditionally-hoistable" &&
        calls[i].ancestorCfif === cfif &&
        (calls[i].branchCondition ?? "true") === cond
      ) {
        g.calls.push(calls[i]);
        i++;
      }
      out.push(g);
    }
  }
  return out;
}

function renderStatement(
  c: ClassifiedCall,
  source: string,
  newIndent: string
): string {
  const text = source.slice(c.statementRange.start, c.statementRange.end);
  const originalLeading = leadingIndentBeforePos(source, c.statementRange.start);
  return reindent(text, newIndent, originalLeading);
}

function leadingIndentBeforePos(source: string, pos: number): number {
  let lineStart = pos;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  let i = lineStart;
  let count = 0;
  while (i < pos && (source[i] === " " || source[i] === "\t")) {
    count++;
    i++;
  }
  return count;
}

function reindent(
  text: string,
  newIndent: string,
  firstLineLeading: number
): string {
  const lines = text.split("\n");
  let minIndent = firstLineLeading;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const m = line.match(/^[ \t]*/);
    const w = m ? m[0].length : 0;
    if (w < minIndent) minIndent = w;
  }
  return lines
    .map((line, i) => {
      if (line.trim().length === 0) return "";
      if (i === 0) return newIndent + line;
      return newIndent + line.slice(minIndent);
    })
    .join("\n");
}

function collapseBlankRuns(text: string): string {
  return text.replace(/(\r?\n)(?:[ \t]*\r?\n){2,}/g, (_m, firstNl: string) => {
    const nl = firstNl.includes("\r") ? "\r\n" : "\n";
    return nl + nl;
  });
}

interface SafetyResult {
  warnings: string[];
  error?: string;
}

function runSafetyChecks(
  source: string,
  output: string,
  classified: ClassifiedCall[]
): SafetyResult {
  const warnings: string[] = [];
  const originalNames = classified.map((c) => c.prcVar);
  const outputCounts = countAssignments(output);
  for (const name of originalNames) {
    const cnt = outputCounts.get(name) ?? 0;
    if (cnt === 0) {
      return {
        warnings,
        error: `Safety check failed: prc.${name} missing from output.`
      };
    }
    if (cnt > 1) {
      return {
        warnings,
        error: `Safety check failed: prc.${name} appears ${cnt} times in output.`
      };
    }
  }
  let outDoc;
  try {
    outDoc = parse(output);
  } catch (e) {
    return {
      warnings,
      error: `Safety check failed: output did not re-parse (${(e as Error).message}).`
    };
  }
  const inCounts = countTagsInDoc(parse(source));
  const outCounts = countTagsInDoc(outDoc);
  if (outCounts.cfqueryNonQoQ > 0) {
    return {
      warnings,
      error: "Safety check failed: non-QoQ <cfquery> tags found in output."
    };
  }
  if (inCounts.cfquery !== outCounts.cfquery) {
    return {
      warnings,
      error: `Safety check failed: <cfquery> count changed (${inCounts.cfquery} -> ${outCounts.cfquery}).`
    };
  }
  for (const tag of ["cfif", "cfelseif", "cfelse"] as const) {
    if (inCounts[tag] !== outCounts[tag]) {
      return {
        warnings,
        error: `Safety check failed: <${tag}> tag count changed (${inCounts[tag]} -> ${outCounts[tag]}).`
      };
    }
  }
  return { warnings };
}

interface TagCounts {
  cfquery: number;
  cfqueryNonQoQ: number;
  cfif: number;
  cfelseif: number;
  cfelse: number;
}

function countTagsInDoc(doc: CFMLDocument): TagCounts {
  const out: TagCounts = {
    cfquery: 0,
    cfqueryNonQoQ: 0,
    cfif: 0,
    cfelseif: 0,
    cfelse: 0
  };
  const visit = (nodes: CFMLNode[]): void => {
    for (const node of nodes) {
      if (node.type === "tag") {
        if (node.name === "cfquery") {
          out.cfquery++;
          const dbtype = node.attributes.get("dbtype");
          if (!dbtype || dbtype.value.toLowerCase() !== "query") {
            out.cfqueryNonQoQ++;
          }
        } else if (node.name === "cfif") out.cfif++;
        else if (node.name === "cfelseif") out.cfelseif++;
        else if (node.name === "cfelse") out.cfelse++;
        if (node.children.length > 0) visit(node.children);
      }
    }
  };
  visit(doc.children);
  return out;
}

function countAssignments(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /\bprc\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*queryExecute\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.set(m[1], (out.get(m[1]) ?? 0) + 1);
  }
  return out;
}

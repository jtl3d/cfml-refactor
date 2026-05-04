import { parse } from "../parser/parse";
import type { CFMLDocument, CFMLNode, TagNode } from "../parser/ast";
import { extractCallsWithSource, type DetectedCall } from "./extractCalls";
import {
  classifyCall,
  type CallCategory,
  type ClassifiedCall,
  type ClassifierOptions
} from "./classifyCall";
import { buildSafeSet } from "./viewSafeFunctions";

export interface AnalyzeOptions {
  extraSafe?: string[];
  handlerPrefixes?: string[];
  servicePatterns?: string[];
}

export interface ViewCallAnalysis {
  filePath: string;
  source: string;
  classified: ClassifiedCall[];
  // Names of functions defined inline in the same file (lowercased).
  localFunctionNames: Set<string>;
  // Counts by category for log output.
  counts: Record<CallCategory, number>;
  totalCalls: number;
}

const DEFAULT_HANDLER_PREFIXES = [
  "get",
  "fetch",
  "load",
  "find",
  "lookup",
  "calculate",
  "compute",
  "validate",
  "check",
  "is",
  "has",
  "can",
  "should",
  "process",
  "apply",
  "transform",
  "convert"
];

const DEFAULT_SERVICE_PATTERNS = [
  "Service",
  "DAO",
  "Gateway",
  "Manager",
  "Repository",
  "Model"
];

export function analyzeViewCalls(
  source: string,
  filePath: string,
  opts: AnalyzeOptions = {}
): ViewCallAnalysis {
  const safe = buildSafeSet(opts.extraSafe ?? []);
  const handlerPrefixes = opts.handlerPrefixes ?? DEFAULT_HANDLER_PREFIXES;
  const servicePatterns = opts.servicePatterns ?? DEFAULT_SERVICE_PATTERNS;

  const doc = parse(source);
  const calls = extractCallsWithSource(doc);
  const localFunctionNames = collectLocalFunctionNames(doc);
  const loopMap = buildLoopIteratorMap(doc);

  const classifierBase: ClassifierOptions = {
    safe,
    handlerPrefixes,
    servicePatterns,
    localFunctionNames
  };

  const classified: ClassifiedCall[] = [];
  for (const c of calls) {
    const iters = pickIterators(c.range.start, loopMap);
    const result = classifyCall(c, { ...classifierBase, loopIterators: iters });
    classified.push(result);
  }

  const counts: Record<CallCategory, number> = {
    "view-safe": 0,
    "view-possible": 0,
    "handler-logic": 0,
    "service-call": 0
  };
  for (const c of classified) counts[c.category]++;

  return {
    filePath,
    source,
    classified,
    localFunctionNames,
    counts,
    totalCalls: classified.length
  };
}

function collectLocalFunctionNames(doc: CFMLDocument): Set<string> {
  const out = new Set<string>();
  const visit = (nodes: CFMLNode[]): void => {
    for (const n of nodes) {
      if (n.type === "tag") {
        if (n.name === "cffunction") {
          const name = n.attributes.get("name")?.value;
          if (name) out.add(name.toLowerCase());
        }
        if (n.children.length > 0) visit(n.children);
      }
    }
  };
  visit(doc.children);
  return out;
}

interface LoopRange {
  start: number;
  end: number;
  iterator: string;
}

function buildLoopIteratorMap(doc: CFMLDocument): LoopRange[] {
  const out: LoopRange[] = [];
  const visit = (nodes: CFMLNode[]): void => {
    for (const n of nodes) {
      if (n.type === "tag") {
        if (n.name === "cfloop") {
          const iterator = pickLoopIterator(n);
          if (iterator) {
            out.push({
              start: n.range.start,
              end: n.range.end,
              iterator: iterator.toLowerCase()
            });
          }
        }
        if (n.children.length > 0) visit(n.children);
      }
    }
  };
  visit(doc.children);
  return out;
}

function pickLoopIterator(tag: TagNode): string | undefined {
  // cfloop has multiple shapes:
  //   <cfloop array="..." index="x">
  //   <cfloop list="..." index="x">
  //   <cfloop from=".." to=".." index="x">
  //   <cfloop query="qry"> — uses the query name; columns become scope-less idents
  //   <cfloop collection="#s#" item="key">
  return (
    tag.attributes.get("index")?.value ??
    tag.attributes.get("item")?.value ??
    tag.attributes.get("query")?.value
  );
}

function pickIterators(offset: number, loops: LoopRange[]): Set<string> {
  const out = new Set<string>();
  for (const l of loops) {
    if (offset >= l.start && offset <= l.end) {
      out.add(l.iterator);
    }
  }
  return out;
}

export function repeatedCallSignature(c: DetectedCall): string {
  // Two calls are "the same" for caching purposes if they share the
  // function name and the (whitespace-collapsed) raw arg text. Receiver
  // chains are part of the signature too.
  const recv = c.receiver ? `${c.receiver}.` : "";
  const args = c.argsText.replace(/\s+/g, "");
  return `${recv}${c.name}(${args})`;
}

export function annotateRepeatedCalls(
  result: ViewCallAnalysis
): Map<string, ClassifiedCall[]> {
  const groups = new Map<string, ClassifiedCall[]>();
  for (const c of result.classified) {
    if (c.category === "view-safe") continue;
    const sig = repeatedCallSignature(c.call);
    const list = groups.get(sig);
    if (list) list.push(c);
    else groups.set(sig, [c]);
  }
  return groups;
}

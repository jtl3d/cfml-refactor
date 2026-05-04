import type { DetectedCall } from "./extractCalls";
import { isViewSafe } from "./viewSafeFunctions";

export type CallCategory =
  | "view-safe"
  | "view-possible"
  | "handler-logic"
  | "service-call";

export type ArgumentSource =
  | "url"
  | "form"
  | "rc"
  | "prc"
  | "session"
  | "cgi"
  | "application"
  | "loop"
  | "literal"
  | "other";

export interface ClassifiedCall {
  call: DetectedCall;
  category: CallCategory;
  // Reason text that fired the rule. Used in diagnostic and webview.
  reason: string;
  // Highest-priority argument-source signal across all args.
  argSources: ArgumentSource[];
  // Suggested next step in plain English.
  suggestion: string;
}

export interface ClassifierOptions {
  safe: Set<string>;
  handlerPrefixes: string[];
  servicePatterns: string[];
  // Names of functions defined inside the same file. Calls to these are
  // tagged with a special suggestion noting "defined in same file".
  localFunctionNames?: Set<string>;
  // Set of loop iterator variable names visible at the call site (best
  // effort — see argument-analysis below). Used to detect loop-bound args.
  loopIterators?: Set<string>;
}

const POSSIBLE_PREFIXES = ["format", "display", "render", "show"];
const POSSIBLE_SUFFIXES = ["display", "label", "text", "html", "string"];

const SERVICE_BUILTIN_NAMES = new Set([
  "getinstance",
  "createobject",
  "entityload",
  "entityloadbypk",
  "entityloadbyexample",
  "entitynew",
  "entitysave",
  "entitydelete",
  "entityreload"
]);

export function classifyCall(
  call: DetectedCall,
  opts: ClassifierOptions
): ClassifiedCall {
  const argSources = analyzeArgumentSources(
    call.args,
    opts.loopIterators ?? new Set()
  );

  const lower = call.name.toLowerCase();

  // 1. Direct service / model bypass — highest priority.
  const serviceFinding = detectServiceCall(call, opts);
  if (serviceFinding) {
    return {
      call,
      category: "service-call",
      reason: serviceFinding.reason,
      argSources,
      suggestion: serviceFinding.suggestion + " " + suggestForArgs(argSources)
    };
  }

  // 2. Built-in or user-extended view-safe.
  if (isViewSafe(call.name, opts.safe)) {
    return {
      call,
      category: "view-safe",
      reason: "Built-in formatting / display function",
      argSources,
      suggestion: ""
    };
  }

  // 3. `new Type(...)` — handled as service call.
  if (lower.startsWith("new ")) {
    return {
      call,
      category: "service-call",
      reason: "Component instantiation in view (`new ...`)",
      argSources,
      suggestion:
        "Move construction to the handler and pass the instance via prc.*."
    };
  }

  // 4. Handler-logic prefix heuristic.
  const handlerHit = matchesHandlerPrefix(call.name, opts.handlerPrefixes);
  if (handlerHit) {
    let reason = `Name starts with "${handlerHit}" — likely handler logic`;
    if (call.assignedTo && /^(prc|rc|variables)\b/i.test(call.assignedTo)) {
      reason += `; result assigned to ${normalizeScope(call.assignedTo)}`;
    }
    return {
      call,
      category: "handler-logic",
      reason,
      argSources,
      suggestion:
        suggestionForHandlerLogic(call, argSources, opts.localFunctionNames)
    };
  }

  // 5. Possible display heuristic — name shape suggests view helper.
  if (looksLikeDisplay(call.name)) {
    return {
      call,
      category: "view-possible",
      reason: "Name shape suggests display logic",
      argSources,
      suggestion:
        "Probably fine as a view helper — if it touches data layer, move to handler."
    };
  }

  // 6. Default: unknown custom function. Without a strong signal we treat
  // as POSSIBLY VIEW-APPROPRIATE per the spec, never as handler logic.
  return {
    call,
    category: "view-possible",
    reason: "Custom function — no strong heuristic match",
    argSources,
    suggestion:
      "If this returns data rather than formatted output, consider moving it to the handler."
  };
}

function detectServiceCall(
  call: DetectedCall,
  opts: ClassifierOptions
): { reason: string; suggestion: string } | undefined {
  const lower = call.name.toLowerCase();

  if (SERVICE_BUILTIN_NAMES.has(lower)) {
    if (lower === "getinstance") {
      const target = stripQuotes(call.args[0] ?? "");
      const suffix = target ? ` ("${target}")` : "";
      return {
        reason: `Direct WireBox lookup${suffix} — view should not resolve services`,
        suggestion:
          "Resolve this service in the handler and pass the data the view needs via prc.*."
      };
    }
    if (lower === "createobject") {
      const target = stripQuotes(call.args[1] ?? "");
      const suffix = target ? ` ("${target}")` : "";
      return {
        reason: `createObject in view${suffix} — view should not instantiate components`,
        suggestion:
          "Move component creation to the handler and pass the result via prc.*."
      };
    }
    if (lower.startsWith("entity")) {
      return {
        reason: `Direct ORM call (${call.name}) in view`,
        suggestion:
          "Move ORM access to the handler or service. The view should read prc.*."
      };
    }
  }

  if (call.receiver) {
    // Walk the chain and check each segment for a service-style suffix.
    const segments = call.receiver.split(".");
    const head = segments[0];
    if (matchesServicePattern(head, opts.servicePatterns)) {
      const matched = pickServicePattern(head, opts.servicePatterns) ?? "Service";
      return {
        reason: `Method call on receiver "${head}" matches "${matched}" suffix`,
        suggestion:
          "Service calls belong in the handler. Set prc.* there and read it here."
      };
    }
    // Common shorthand: `wirebox.getInstance(...)` or
    // `application.wirebox.getInstance(...)`.
    if (segments.includes("wirebox") && lower === "getinstance") {
      const target = stripQuotes(call.args[0] ?? "");
      const suffix = target ? ` ("${target}")` : "";
      return {
        reason: `Direct WireBox lookup${suffix} via wirebox.getInstance`,
        suggestion:
          "Resolve this service in the handler and pass data to the view via prc.*."
      };
    }
  }

  return undefined;
}

function matchesServicePattern(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (!p) continue;
    if (name.toLowerCase().endsWith(p.toLowerCase())) return true;
  }
  return false;
}

function pickServicePattern(name: string, patterns: string[]): string | undefined {
  for (const p of patterns) {
    if (!p) continue;
    if (name.toLowerCase().endsWith(p.toLowerCase())) return p;
  }
  return undefined;
}

function matchesHandlerPrefix(name: string, prefixes: string[]): string | null {
  // Match camelCase: prefix followed by an uppercase letter or end-of-string.
  for (const p of prefixes) {
    if (!p) continue;
    if (name.length < p.length) continue;
    if (name.slice(0, p.length).toLowerCase() !== p.toLowerCase()) continue;
    const next = name.charAt(p.length);
    if (next === "" || /[A-Z_]/.test(next)) return p;
  }
  return null;
}

function looksLikeDisplay(name: string): boolean {
  const lower = name.toLowerCase();
  for (const p of POSSIBLE_PREFIXES) {
    if (lower.startsWith(p)) {
      const rest = lower.slice(p.length);
      if (rest.length === 0 || /[A-Z]/.test(name.charAt(p.length))) return true;
    }
  }
  for (const s of POSSIBLE_SUFFIXES) {
    if (lower.endsWith(s) && name.length > s.length) {
      const before = name.charAt(name.length - s.length - 1);
      if (/[a-z]/.test(before)) return true;
    }
  }
  return false;
}

function analyzeArgumentSources(
  args: string[],
  loopIterators: Set<string>
): ArgumentSource[] {
  const out = new Set<ArgumentSource>();
  for (const raw of args) {
    if (raw.length === 0) continue;
    const cleaned = stripHashes(raw).trim();
    classifyArgRecursive(cleaned, loopIterators, out);
  }
  if (out.size === 0) return [];
  // Order matters for suggestion construction. Highest priority first.
  const order: ArgumentSource[] = [
    "url",
    "form",
    "rc",
    "prc",
    "session",
    "cgi",
    "application",
    "loop",
    "literal",
    "other"
  ];
  return order.filter((s) => out.has(s));
}

function classifyArgRecursive(
  text: string,
  loopIterators: Set<string>,
  out: Set<ArgumentSource>
): void {
  if (text.length === 0) return;
  // Literal-only?
  if (isLiteral(text)) {
    out.add("literal");
    return;
  }
  const ids = collectIdentifiers(text);
  let added = false;
  for (const id of ids) {
    const head = id.split(".")[0].toLowerCase();
    if (head === "url") {
      out.add("url");
      added = true;
    } else if (head === "form") {
      out.add("form");
      added = true;
    } else if (head === "rc") {
      out.add("rc");
      added = true;
    } else if (head === "prc") {
      out.add("prc");
      added = true;
    } else if (head === "session") {
      out.add("session");
      added = true;
    } else if (head === "cgi") {
      out.add("cgi");
      added = true;
    } else if (head === "application") {
      out.add("application");
      added = true;
    } else if (loopIterators.has(head)) {
      out.add("loop");
      added = true;
    }
  }
  if (!added) out.add("other");
}

function isLiteral(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return true;
  if (/^"([^"\\]|\\.)*"$/.test(t)) return true;
  if (/^'([^'\\]|\\.)*'$/.test(t)) return true;
  if (/^(true|false|null)$/i.test(t)) return true;
  return false;
}

function stripHashes(text: string): string {
  // Drop leading and trailing `#` if it's a single hash-wrapped expression.
  let t = text.trim();
  if (t.startsWith("#") && t.endsWith("#") && t.length >= 2) {
    t = t.slice(1, -1);
  }
  return t;
}

function collectIdentifiers(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipStr(text, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) i++;
      out.push(text.slice(start, i));
      continue;
    }
    i++;
  }
  return out;
}

function skipStr(text: string, i: number): number {
  const q = text[i];
  i++;
  while (i < text.length) {
    if (text[i] === q) {
      if (text[i + 1] === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length;
}

function suggestForArgs(sources: ArgumentSource[]): string {
  if (sources.length === 0) return "";
  if (sources.includes("loop")) {
    return "Args reference loop iterator — after Phase 4 loop restructuring, this can move into the view-model builder.";
  }
  if (sources.includes("url") || sources.includes("form") || sources.includes("rc")) {
    return "Handler can read these args from rc.";
  }
  if (sources.includes("session") || sources.includes("cgi") || sources.includes("application")) {
    return "These scopes are also available in the handler.";
  }
  if (sources.includes("prc")) {
    return "Move next to the prc set that produces these args in the handler.";
  }
  if (sources.length === 1 && sources[0] === "literal") {
    return "Args are literals — easy lift, just a constant.";
  }
  return "";
}

function suggestionForHandlerLogic(
  call: DetectedCall,
  argSources: ArgumentSource[],
  localFunctions: Set<string> | undefined
): string {
  const base =
    `Move this call to the handler. The handler should set ` +
    (call.assignedTo
      ? `${normalizeScope(call.assignedTo)}`
      : `prc.${call.name}`) +
    ` so the view just reads it.`;
  const args = suggestForArgs(argSources);
  let suffix = "";
  if (
    localFunctions &&
    localFunctions.has(call.name.toLowerCase())
  ) {
    suffix =
      " Note: function is defined in the same file — consider moving the function to a helper or service.";
  }
  if (args.length === 0) return base + suffix;
  return `${base} ${args}${suffix}`;
}

function normalizeScope(target: string): string {
  // Convert `prc.user.id` to `prc.user`. Leaves single-token like
  // `prc.users` alone.
  const parts = target.split(".");
  if (parts.length <= 2) return target;
  return parts.slice(0, 2).join(".");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

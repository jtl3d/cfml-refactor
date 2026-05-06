// Built-in CFML functions whose calls are considered safe to keep verbatim as
// the value of a queryExecute param. The user can extend this list via the
// `cfml-refactor.safeBuiltInFunctions` setting; entries are merged
// case-insensitively.
//
// Stored lower-case for case-insensitive lookup. Keep alphabetical within
// each group for easy maintenance.
export const DEFAULT_SAFE_BUILTIN_FUNCTIONS: ReadonlyArray<string> = [
  // string
  "trim", "ltrim", "rtrim",
  "ucase", "lcase",
  "len",
  "left", "right", "mid",
  "replace", "replacenocase",
  "urlencodedformat", "htmleditformat",
  "tostring",
  // date/time
  "dateformat", "timeformat", "datetimeformat",
  "createdate", "createdatetime",
  "createodbcdate", "createodbcdatetime",
  "now",
  "parsedatetime",
  // numeric
  "val", "int",
  "round", "ceiling", "floor", "abs",
  "tonumeric",
  // misc
  "javacast",
  "hash"
];

export function buildSafeBuiltInSet(extra: ReadonlyArray<string> = []): Set<string> {
  const out = new Set<string>(DEFAULT_SAFE_BUILTIN_FUNCTIONS.map((n) => n.toLowerCase()));
  for (const name of extra) {
    if (typeof name === "string" && name.length > 0) {
      out.add(name.toLowerCase());
    }
  }
  return out;
}

// Decide whether `value` (the raw text of a `<cfqueryparam value="...">`
// attribute) is safe to keep verbatim as a queryExecute param value. We accept
// values of the form `#<expr>#` where <expr> is a single function call to a
// safelisted built-in CFML function whose arguments are themselves safe:
// numeric or string literals, dotted-but-non-call identifier references, or
// nested safe built-in calls. Anything else — string concatenation, math,
// IIF/ternary, method calls (`obj.method(...)`), unknown functions — returns
// false so the surrounding query is treated as too complex to convert.
export function isSafeBuiltInExpression(
  value: string,
  safelist: Set<string>
): boolean {
  if (value.length < 3) return false;
  if (!value.startsWith("#") || !value.endsWith("#")) return false;
  const inner = value.slice(1, -1);
  if (inner.includes("#")) return false;

  let i = 0;
  const peek = (): string => inner[i] ?? "";
  const skipWs = (): void => {
    while (i < inner.length && /\s/.test(inner[i])) i++;
  };
  const consume = (ch: string): boolean => {
    skipWs();
    if (peek() === ch) {
      i++;
      return true;
    }
    return false;
  };
  const readIdentifier = (): string | null => {
    skipWs();
    const m = inner.slice(i).match(/^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*/);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const readNumber = (): boolean => {
    skipWs();
    const m = inner.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (!m) return false;
    i += m[0].length;
    return true;
  };
  const readString = (): boolean => {
    skipWs();
    const q = peek();
    if (q !== "'" && q !== '"') return false;
    i++;
    while (i < inner.length) {
      if (inner[i] === q) {
        if (inner[i + 1] === q) {
          i += 2;
          continue;
        }
        i++;
        return true;
      }
      i++;
    }
    return false;
  };

  // parseArg consumes one of: number literal, string literal, dotted
  // identifier (no call), or a nested safe built-in function call.
  const parseArg = (): boolean => {
    skipWs();
    const c = peek();
    if (c === "'" || c === '"') return readString();
    if (c === "-" || (c >= "0" && c <= "9")) return readNumber();
    const ident = readIdentifier();
    if (ident === null) return false;
    skipWs();
    if (peek() === "(") {
      if (ident.includes(".")) return false; // method call — reject
      if (!safelist.has(ident.toLowerCase())) return false;
      i++; // (
      skipWs();
      if (peek() === ")") {
        i++;
        return true;
      }
      if (!parseArg()) return false;
      while (true) {
        skipWs();
        if (consume(",")) {
          if (!parseArg()) return false;
          continue;
        }
        break;
      }
      return consume(")");
    }
    return true;
  };

  skipWs();
  const top = readIdentifier();
  if (top === null) return false;
  if (top.includes(".")) return false;
  skipWs();
  if (peek() !== "(") return false;
  if (!safelist.has(top.toLowerCase())) return false;
  i++; // (
  skipWs();
  if (peek() === ")") {
    i++;
  } else {
    if (!parseArg()) return false;
    while (true) {
      skipWs();
      if (consume(",")) {
        if (!parseArg()) return false;
        continue;
      }
      break;
    }
    if (!consume(")")) return false;
  }
  skipWs();
  return i === inner.length;
}

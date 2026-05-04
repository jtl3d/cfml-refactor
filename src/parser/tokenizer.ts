import type { AttributeValue, Range } from "./ast";

export type Token =
  | OpenTagToken
  | CloseTagToken
  | CommentToken
  | ScriptToken
  | ContentToken;

export interface OpenTagToken {
  kind: "openTag";
  name: string;
  attributes: Map<string, AttributeValue>;
  selfClosing: boolean;
  range: Range;
}

export interface CloseTagToken {
  kind: "closeTag";
  name: string;
  range: Range;
}

export interface CommentToken {
  kind: "comment";
  text: string;
  range: Range;
}

export interface ScriptToken {
  kind: "script";
  body: string;
  bodyRange: Range;
  range: Range;
}

export interface ContentToken {
  kind: "content";
  text: string;
  range: Range;
}

const NAME_CHAR = /[A-Za-z0-9_:]/;
const WS = /\s/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let contentStart = 0;

  const flushContent = (end: number): void => {
    if (end > contentStart) {
      tokens.push({
        kind: "content",
        text: source.slice(contentStart, end),
        range: { start: contentStart, end }
      });
    }
  };

  while (pos < source.length) {
    if (source.startsWith("<!---", pos)) {
      flushContent(pos);
      const start = pos;
      pos += 5;
      let depth = 1;
      while (pos < source.length && depth > 0) {
        if (source.startsWith("<!---", pos)) {
          depth++;
          pos += 5;
        } else if (source.startsWith("--->", pos)) {
          depth--;
          pos += 4;
        } else {
          pos++;
        }
      }
      tokens.push({
        kind: "comment",
        text: source.slice(start, pos),
        range: { start, end: pos }
      });
      contentStart = pos;
      continue;
    }

    if (source[pos] === "<" && isCfTagStart(source, pos)) {
      const result = parseTag(source, pos);
      if (result) {
        flushContent(pos);
        const tok = result.token;
        // cfscript: capture body opaquely as a single script token
        if (
          tok.kind === "openTag" &&
          tok.name === "cfscript" &&
          !tok.selfClosing
        ) {
          const bodyStart = result.next;
          const closeIdx = findCfscriptClose(source, bodyStart);
          if (closeIdx >= 0) {
            const closeMatch = source
              .slice(closeIdx)
              .match(/^<\/cfscript\s*>/i);
            const closeLen = closeMatch ? closeMatch[0].length : 11;
            tokens.push({
              kind: "script",
              body: source.slice(bodyStart, closeIdx),
              bodyRange: { start: bodyStart, end: closeIdx },
              range: { start: tok.range.start, end: closeIdx + closeLen }
            });
            pos = closeIdx + closeLen;
            contentStart = pos;
            continue;
          }
          // Unterminated cfscript — emit script token to EOF
          tokens.push({
            kind: "script",
            body: source.slice(bodyStart),
            bodyRange: { start: bodyStart, end: source.length },
            range: { start: tok.range.start, end: source.length }
          });
          pos = source.length;
          contentStart = pos;
          continue;
        }
        tokens.push(tok);
        pos = result.next;
        contentStart = pos;
        continue;
      }
    }

    pos++;
  }

  flushContent(pos);
  return tokens;
}

function isCfTagStart(source: string, pos: number): boolean {
  let i = pos + 1;
  if (source[i] === "/") i++;
  return (
    (source[i] === "c" || source[i] === "C") &&
    (source[i + 1] === "f" || source[i + 1] === "F") &&
    NAME_CHAR.test(source[i + 2] ?? "")
  );
}

function parseTag(
  source: string,
  start: number
): { token: Token; next: number } | null {
  let pos = start + 1;
  let isClose = false;
  if (source[pos] === "/") {
    isClose = true;
    pos++;
  }
  const nameStart = pos;
  while (pos < source.length && NAME_CHAR.test(source[pos])) pos++;
  const name = source.slice(nameStart, pos).toLowerCase();
  if (!name) return null;

  if (isClose) {
    while (pos < source.length && source[pos] !== ">") pos++;
    if (pos >= source.length) return null;
    const end = pos + 1;
    return {
      token: { kind: "closeTag", name, range: { start, end } },
      next: end
    };
  }

  const attributes = new Map<string, AttributeValue>();
  let selfClosing = false;
  let end = pos;

  while (pos < source.length) {
    while (pos < source.length && WS.test(source[pos])) pos++;
    if (pos >= source.length) return null;
    if (source[pos] === ">") {
      end = pos + 1;
      pos = end;
      break;
    }
    if (source[pos] === "/" && source[pos + 1] === ">") {
      selfClosing = true;
      end = pos + 2;
      pos = end;
      break;
    }
    const attrNameStart = pos;
    while (pos < source.length && !/[\s=>/]/.test(source[pos])) pos++;
    const attrName = source.slice(attrNameStart, pos).toLowerCase();
    if (!attrName) {
      pos++;
      continue;
    }
    let savedPos = pos;
    while (pos < source.length && WS.test(source[pos])) pos++;
    let value: AttributeValue = {
      raw: "",
      value: "",
      hasInterpolation: false,
      range: { start: attrNameStart, end: savedPos }
    };
    if (source[pos] === "=") {
      pos++;
      while (pos < source.length && WS.test(source[pos])) pos++;
      const valStart = pos;
      const quote = source[pos];
      if (quote === '"' || quote === "'") {
        pos++;
        const innerStart = pos;
        while (pos < source.length) {
          if (source[pos] === quote) {
            if (source[pos + 1] === quote) {
              pos += 2;
              continue;
            }
            break;
          }
          pos++;
        }
        const innerEnd = pos;
        if (pos < source.length) pos++;
        const inner = source.slice(innerStart, innerEnd);
        const unescaped = inner.split(quote + quote).join(quote);
        value = {
          raw: source.slice(valStart, pos),
          value: unescaped,
          hasInterpolation: containsInterpolation(inner),
          range: { start: attrNameStart, end: pos }
        };
      } else {
        while (pos < source.length && !/[\s>/]/.test(source[pos])) pos++;
        const inner = source.slice(valStart, pos);
        value = {
          raw: inner,
          value: inner,
          hasInterpolation: containsInterpolation(inner),
          range: { start: attrNameStart, end: pos }
        };
      }
    } else {
      pos = savedPos;
    }
    attributes.set(attrName, value);
  }

  return {
    token: {
      kind: "openTag",
      name,
      attributes,
      selfClosing,
      range: { start, end }
    },
    next: pos
  };
}

function containsInterpolation(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    if (s[i] === "#") {
      if (s[i + 1] === "#") {
        i += 2;
        continue;
      }
      return true;
    }
    i++;
  }
  return false;
}

function findCfscriptClose(source: string, from: number): number {
  const re = /<\/cfscript\s*>/gi;
  re.lastIndex = from;
  const m = re.exec(source);
  return m ? m.index : -1;
}

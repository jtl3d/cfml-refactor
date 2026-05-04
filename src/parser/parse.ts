import type { CFMLDocument, CFMLNode, Range, TagNode } from "./ast";
import { tokenize, type Token } from "./tokenizer";

const CONTAINER_TAGS = new Set([
  "cfquery",
  "cfloop",
  "cfif",
  "cfoutput",
  "cfsavecontent",
  "cftry",
  "cfcatch",
  "cffunction",
  "cfcomponent",
  "cfsilent",
  "cfthread",
  "cftransaction"
]);

const VOID_DEFAULTS = new Set([
  "cfqueryparam",
  "cfset",
  "cfelseif",
  "cfelse",
  "cfinclude",
  "cfparam",
  "cfargument",
  "cfreturn",
  "cfdump",
  "cfabort",
  "cflocation",
  "cfheader",
  "cfcontent",
  "cfflush",
  "cfthrow",
  "cfrethrow",
  "cfbreak",
  "cfcontinue"
]);

export function parse(source: string): CFMLDocument {
  const tokens = tokenize(source);
  const state = { i: 0, tokens };
  const children = parseChildren(state, undefined);
  return { source, children };
}

interface ParseState {
  i: number;
  tokens: Token[];
}

function parseChildren(
  state: ParseState,
  stopAt: string | undefined
): CFMLNode[] {
  const out: CFMLNode[] = [];
  while (state.i < state.tokens.length) {
    const t = state.tokens[state.i];
    if (t.kind === "closeTag") {
      if (stopAt && t.name === stopAt) {
        return out;
      }
      // Unmatched close — drop it and continue.
      state.i++;
      continue;
    }
    if (t.kind === "openTag") {
      state.i++;
      const isVoid =
        t.selfClosing ||
        VOID_DEFAULTS.has(t.name) ||
        !CONTAINER_TAGS.has(t.name);
      if (isVoid) {
        const node: TagNode = {
          type: "tag",
          name: t.name,
          attributes: t.attributes,
          selfClosing: true,
          range: t.range,
          openTagRange: t.range,
          children: []
        };
        out.push(node);
      } else {
        const children = parseChildren(state, t.name);
        let end = t.range.end;
        let closeRange: Range | undefined;
        const next = state.tokens[state.i];
        if (next && next.kind === "closeTag" && next.name === t.name) {
          closeRange = next.range;
          end = next.range.end;
          state.i++;
        }
        const node: TagNode = {
          type: "tag",
          name: t.name,
          attributes: t.attributes,
          selfClosing: false,
          range: { start: t.range.start, end },
          openTagRange: t.range,
          closeTagRange: closeRange,
          children
        };
        out.push(node);
      }
    } else if (t.kind === "script") {
      state.i++;
      out.push({
        type: "script",
        range: t.range,
        bodyRange: t.bodyRange,
        body: t.body
      });
    } else if (t.kind === "comment") {
      state.i++;
      out.push({
        type: "comment",
        range: t.range,
        text: t.text
      });
    } else {
      state.i++;
      out.push({
        type: "content",
        range: t.range,
        text: t.text
      });
    }
  }
  return out;
}

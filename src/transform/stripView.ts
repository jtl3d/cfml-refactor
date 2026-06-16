// Strip a CFML view down to its logic skeleton: keep `cf*` tags, `<cfscript>`
// blocks, and `<!--- --->` comments; drop all HTML markup and text output.
//
// Crucially, cf logic that lives *inside* an HTML tag (between a `<htmltag` and
// its closing `>`) is dropped along with that tag — e.g.
//   <tr id="" <cfif foo>name=""</cfif>>
// becomes nothing, because the `<cfif>` is part of the `<tr>` open tag, not a
// statement in the content flow. The AST would store these as siblings, so we
// scan the raw source instead and treat the whole `<...>` as one HTML span.

export interface StripViewResult {
  output: string;
  cfConstructsKept: number;
  commentsKept: number;
  htmlTagsStripped: number;
}

const NAME_CHAR = /[A-Za-z0-9_:]/;

// Tags whose entire body is logic (not presentation) and must be carried over
// verbatim — including the text between open and close. `<cfquery>` holds SQL,
// `<cfstoredproc>` its proc call, `<cfscript>` arbitrary code.
const VERBATIM_BLOCK_TAGS = new Set(["cfscript", "cfquery", "cfstoredproc"]);

export function stripView(source: string): StripViewResult {
  const out: string[] = [];
  let pos = 0;
  let cfConstructsKept = 0;
  let commentsKept = 0;
  let htmlTagsStripped = 0;

  while (pos < source.length) {
    // CFML comment — keep verbatim.
    if (source.startsWith("<!---", pos)) {
      const end = findCfCommentEnd(source, pos);
      out.push(source.slice(pos, end));
      commentsKept++;
      pos = end;
      continue;
    }

    const ch = source[pos];

    // CFML tag (open / close / void). A verbatim-block tag (cfquery, cfscript,
    // cfstoredproc) is carried over whole — body included — since its contents
    // are logic, not markup.
    if (ch === "<" && isCfTagStart(source, pos)) {
      const blockName = verbatimBlockOpen(source, pos);
      if (blockName) {
        const end = findBlockEnd(source, pos, blockName);
        out.push(source.slice(pos, end));
        cfConstructsKept++;
        pos = end;
        continue;
      }
      const end = findTagEnd(source, pos);
      out.push(source.slice(pos, end));
      if (!isCloseTag(source, pos)) cfConstructsKept++;
      pos = end;
      continue;
    }

    // HTML tag (or HTML comment / doctype) — drop the whole span, including any
    // cf logic embedded in its attributes. Preserve only newlines so the
    // surrounding logic keeps its vertical layout.
    if (ch === "<" && htmlTagStartsHere(source, pos)) {
      const end = findHtmlTagEnd(source, pos);
      for (let i = pos; i < end; i++) {
        if (source[i] === "\n") out.push("\n");
      }
      htmlTagsStripped++;
      pos = end;
      continue;
    }

    // Plain text / output content — drop, but preserve whitespace so kept
    // logic retains its indentation and line breaks.
    if (ch === "\n" || ch === "\t" || ch === " ") out.push(ch);
    pos++;
  }

  return {
    output: cleanup(out.join("")),
    cfConstructsKept,
    commentsKept,
    htmlTagsStripped
  };
}

function cleanup(text: string): string {
  const lines = text.split("\n").map((l) => l.replace(/[ \t\r]+$/, ""));
  const result: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === "") {
      blankRun++;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    result.push(line);
  }
  while (result.length > 0 && result[0] === "") result.shift();
  while (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result.length > 0 ? result.join("\n") + "\n" : "";
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

function isCloseTag(source: string, pos: number): boolean {
  return source[pos + 1] === "/";
}

// If pos begins an opening verbatim-block tag, return its lowercased name.
function verbatimBlockOpen(source: string, pos: number): string | null {
  if (isCloseTag(source, pos)) return null;
  let i = pos + 1;
  const nameStart = i;
  while (i < source.length && NAME_CHAR.test(source[i])) i++;
  const name = source.slice(nameStart, i).toLowerCase();
  return VERBATIM_BLOCK_TAGS.has(name) ? name : null;
}

function htmlTagStartsHere(source: string, pos: number): boolean {
  let i = pos + 1;
  if (source[i] === "!") return true; // <!-- ... --> or <!DOCTYPE ...>
  if (source[i] === "/") i++;
  return /[A-Za-z]/.test(source[i] ?? "");
}

function findCfCommentEnd(source: string, start: number): number {
  let pos = start + 5;
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
  return pos;
}

// Find the index just past the matching `</name>` close tag. If there is none
// (e.g. a self-closing block tag), fall back to the end of the open tag.
function findBlockEnd(source: string, start: number, name: string): number {
  const openEnd = findTagEnd(source, start);
  const re = new RegExp(`</${name}\\s*>`, "gi");
  re.lastIndex = openEnd;
  const m = re.exec(source);
  return m ? m.index + m[0].length : openEnd;
}

// Find the index just past the closing `>` of a single `<...>` tag, honoring
// quoted attribute values and `#...#` interpolation (which may contain quotes).
function findTagEnd(source: string, start: number): number {
  let pos = start + 1;
  if (source[pos] === "/") pos++;
  while (pos < source.length && NAME_CHAR.test(source[pos])) pos++;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '"' || ch === "'") {
      pos = skipQuoted(source, pos);
      continue;
    }
    if (ch === "#") {
      pos = skipInterpolation(source, pos);
      continue;
    }
    if (ch === ">") return pos + 1;
    pos++;
  }
  return source.length;
}

// Find the index just past the end of an HTML tag, skipping over quoted values
// and any nested cf tags / cf comments so their `>` characters don't close the
// HTML tag early.
function findHtmlTagEnd(source: string, start: number): number {
  if (source.startsWith("<!--", start) && !source.startsWith("<!---", start)) {
    const idx = source.indexOf("-->", start + 4);
    return idx < 0 ? source.length : idx + 3;
  }
  let pos = start + 1;
  if (source[pos] === "/") pos++;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '"' || ch === "'") {
      // HTML attribute values commonly contain a literal `#` (href="#",
      // style="#fff"), so a plain quote scan is used here rather than the
      // interpolation-aware one — we only need to avoid a `>` inside quotes.
      pos = skipQuotedSimple(source, pos);
      continue;
    }
    if (ch === "<") {
      if (source.startsWith("<!---", pos)) {
        pos = findCfCommentEnd(source, pos);
      } else {
        pos = findTagEnd(source, pos);
      }
      continue;
    }
    if (ch === ">") return pos + 1;
    pos++;
  }
  return source.length;
}

// pos is at an opening quote. Return the index just past the next matching
// quote, treating the contents as opaque (no interpolation handling).
function skipQuotedSimple(source: string, pos: number): number {
  const quote = source[pos];
  pos++;
  while (pos < source.length && source[pos] !== quote) pos++;
  return pos < source.length ? pos + 1 : pos;
}

// pos is at an opening quote. Return the index just past the matching close.
function skipQuoted(source: string, pos: number): number {
  const quote = source[pos];
  pos++;
  let inInterp = false;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === "#") {
      if (!inInterp && source[pos + 1] === "#") {
        pos += 2;
        continue;
      }
      inInterp = !inInterp;
      pos++;
      continue;
    }
    if (inInterp && (ch === '"' || ch === "'")) {
      pos++;
      while (pos < source.length) {
        if (source[pos] === ch) {
          if (source[pos + 1] === ch) {
            pos += 2;
            continue;
          }
          pos++;
          break;
        }
        pos++;
      }
      continue;
    }
    if (!inInterp && ch === quote) {
      if (source[pos + 1] === quote) {
        pos += 2;
        continue;
      }
      return pos + 1;
    }
    pos++;
  }
  return pos;
}

// pos is at a `#`. Return the index just past the closing `#` (or past `##`).
function skipInterpolation(source: string, pos: number): number {
  if (source[pos + 1] === "#") return pos + 2;
  pos++;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '"' || ch === "'") {
      pos = skipQuoted(source, pos);
      continue;
    }
    if (ch === "#") return pos + 1;
    pos++;
  }
  return pos;
}

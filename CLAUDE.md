# CFML Refactor

VS Code extension (TypeScript) that detects and refactors database queries and
page logic in CFML (`.cfm`/`.cfc`) files. Not on the Marketplace — distributed
as a sideloaded `.vsix`. Entry point `dist/extension.js` (esbuild bundle).

## Commands (build / test / ship)

```bash
npm run build      # esbuild dev bundle -> dist/ (sourcemaps, no minify)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit, uses tsconfig.json (strict)
npm test           # tsc -p tsconfig.test.json -> out-test/, then mocha
npm run package:patch   # bump version + build .vsix into dist/
npm run release:patch   # bump + commit + tag + push (CI builds the .vsix)
```

**Gotcha:** `tsc` never deletes stale files from `out-test/`. After deleting or
renaming a test/source file, run `rm -rf out-test` before `npm test` — otherwise
mocha runs the stale compiled `.js` and you get phantom failures.

`tsconfig.json` (typecheck + the real build) has `noUnusedLocals` /
`noUnusedParameters` **on**; `tsconfig.test.json` turns them **off**. Always run
`npm run typecheck` — `npm test` alone won't catch unused imports/params.

## Pipeline / architecture

`src/` flows in one direction: **parser → analyzer → transform → commands → extension**.

- **`src/parser/`** — `tokenizer.ts` → `parse.ts` → `ast.ts`.
  - The tokenizer only recognizes `cf*` tags and `<!--- --->` comments. **All
    raw HTML and text becomes `ContentNode`s** — there are no HTML `TagNode`s.
  - `<cfscript>` bodies are captured opaquely as a single `ScriptNode`.
  - AST node types: `TagNode | ScriptNode | ContentNode | CommentNode`. Every
    node carries absolute-offset `Range`s into the source. Tags also have
    `openTagRange` and optional `closeTagRange`; children tile the gap between.
  - Attribute values may contain `#...#` interpolation, and a `#...#` block may
    itself contain quotes (e.g. `value="#GetToken(i,2,"_")#"`) — the tokenizer
    tracks interpolation depth so nested quotes don't end the attribute early.
- **`src/analyzer/`** — `findQueries.ts` (`analyze()`), `extractCalls.ts`,
  `classifyCall.ts`, `analyzeViewCalls.ts`. Builds `QueryInfo` / `QueryParamInfo`
  (`types.ts`) from the AST.
- **`src/transform/`** — pure functions, source-in / string-out. No VS Code API.
  - `convertQuery.ts` — `<cfquery>` → `queryExecute(...)`. Three output styles:
    `phase2` (plain), `ternary` / Style A (text-only `<cfif>` chains), and
    `variable-based` / Style B (`<cfqueryparam>` inside `<cfif>` branches).
    `shouldSkipTransform()` decides what is too complex to convert.
    **A `<cfqueryparam value>` is always carried over verbatim** as the param's
    `value:` expression (function calls included) — no value shape skips.
  - `convertCfmToHandler.ts` — a `.cfm` page → ColdBox handler `.cfc` + view.
  - `hoistQueries.ts`, `renameQueries.ts`, `urlFormToRc.ts`.
- **`src/commands/`** — thin VS Code wrappers: read config/editor, call a
  transform, apply a `WorkspaceEdit` or write files, log to an OutputChannel.
- **`src/index/`** — workspace query index for "find similar / extractable".
- **`src/extension.ts`** — registers every command.

`scripts/run-cfm-to-handler.js` drives `convertCfmToHandler` from the CLI
against `out-test/` — handy for eyeballing output without the extension host.

## convertCfmToHandler details

`splitHandlerView()` splits top-level nodes into a **handler prefix** and a
**view suffix** (ColdBox runs the handler, then renders the view).

- `isViewLike()` classifies a node: raw content/comments are view; `<cfoutput>`
  is **always** view; `<cfif>`/`<cfloop>`/`<cfswitch>` are view **only when
  their subtree contains markup** (`tagContainsMarkup()`); everything else is
  handler logic.
- Handler `<cfset>`/`<cfquery>` names referenced by the view are rescoped to
  `prc`; `collectViewReferenced()` finds those references (in `#...#`, `<cfif>`
  conditions, and `query`/`array`/`collection`/`condition` attributes).
- `rewriteViewSource()` rebuilds the view from its nodes, qualifying those
  references (`#x#`→`#prc.x#`, `query="x"`→`query="prc.x"`, `<cfif x>`→
  `<cfif prc.x>`). Raw HTML is copied verbatim.

## Tests

Mocha + `assert`, in `test/*.test.ts`, importing from `../src/...`. Fixture-based
suites read `test/fixtures/`. Add focused unit tests next to the behavior you
change.

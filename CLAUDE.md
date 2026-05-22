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

`processNodes()` / `processNode()` recursively partition the page into a
**handler part** (cfscript) and a **view part** (markup). ColdBox runs the
handler, then renders the view.

- Pure logic → handler (via the `emit*` tag converters); pure markup → view
  (via `rewriteViewSource()`).
- **Mixed containers** are split. `processCfoutput()` splits its children.
  `processCfif()` duplicates the condition — guarded logic in the handler,
  guarded markup in the view. `processCfloop()` over a loop that wraps both
  markup and a query calls `emitViewModelLoop()`.
- **View model** (`emitViewModelLoop()`): the handler reproduces the loop to
  fill `prc.<query> = {}` keyed by `currentRow` (query loops) or the index
  (from/to loops); the view keeps the loop and injects
  `<cfset <query> = prc.<query>[<key>]>` so the surrounding markup is otherwise
  unchanged. Loop shapes it can't restructure fall back to whole-loop-to-handler.
- `tagContainsDataAccess()` (a `<cfquery>`/`<cfstoredproc>` in the subtree)
  forces a container to the handler; `tagContainsMarkup()` detects presentation.
- Handler `<cfset>`/`<cfquery>` names referenced by the view are rescoped to
  `prc` (`collectViewReferenced()` finds references in `#...#`, `<cfif>`
  conditions, and `query`/`array`/`collection`/`condition` attributes;
  `applyScoping()` rewrites the handler, `rewriteViewSource()` the view).

## Tests

Mocha + `assert`, in `test/*.test.ts`, importing from `../src/...`. Fixture-based
suites read `test/fixtures/`. Add focused unit tests next to the behavior you
change.

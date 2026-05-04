# SQL extraction in Phase 5

Phase 5 extracts a small structural summary from each query (tables, SELECT
columns, WHERE columns) so we can match queries fuzzily across the
workspace. Extraction is deliberately a lightweight regex/tokenizer pass —
not a full SQL parser — and it has known limitations.

This document records what we extract, how, and what we knowingly miss.
The fingerprint (a SHA-1 over normalized SQL) drives EXACT matches and is
robust; the structural fields drive STRUCTURAL and TABLE-OVERLAP matches
and are intentionally best-effort.

## Normalization pipeline

Applied in order to the raw SQL body before fingerprinting:

1. Strip CFML comments (`<!--- ... --->`)
2. Replace `<cfqueryparam ...>` tags with the placeholder `?`
3. Strip SQL line and block comments (`-- ...`, `/* ... */`)
4. Replace string literals (`'...'`, `"..."`) with `?`
5. Replace `:name` and stray `?` placeholders with `?`
6. Replace numeric literals with `?`
7. Lowercase SQL keywords; preserve identifier case (configurable)
8. Collapse whitespace runs to single spaces
9. Trim and strip trailing semicolons
10. Optionally strip single/short-letter table aliases after `FROM`/`JOIN`

The fingerprint is the SHA-1 of the resulting string.

## What we extract

### Tables (`tables[]`)

Identifiers appearing after `FROM` or `JOIN`, up to the next clause
keyword (`WHERE`, `GROUP`, `ORDER`, `HAVING`, `LIMIT`, etc.) or another
join keyword. Comma-separated lists are supported. Simple aliases (the
identifier directly after the table name, when not a keyword) are
ignored. Output is deduped and sorted.

### SELECT columns (`columns[]`)

Items between `SELECT` (and an optional `DISTINCT`) and the matching
`FROM`. For each comma-separated item:

- `id` → `id`
- `u.id` → `id` (table prefix stripped to maximize matches)
- `u.id AS userId` → `id` (alias stripped)
- `u.id userId` → `id` (trailing alias without `AS` stripped if it is
  not a keyword)
- `COUNT(*) AS total` → `count_*` (function name + arg, lowercased and
  underscore-joined)
- `MAX(price)` → `max_price`

Order is preserved as written (we do not sort `columns[]`, since order
can be meaningful for downstream display, but match comparison is
order-sensitive — see "Limitations" below).

### WHERE columns (`whereColumns[]`)

Identifiers on the left side of comparisons inside a `WHERE` clause:
`x = ...`, `x <> ...`, `x LIKE ...`, `x IN (...)`, `x BETWEEN ...`,
`x IS NULL`, etc. We stop at the next clause keyword
(`GROUP`, `ORDER`, `HAVING`, `LIMIT`, `UNION`, ...). Output is deduped
and sorted.

`ORDER BY` columns are deliberately not collected: a query that differs
only by `ORDER BY` will produce a different fingerprint (so it is not
EXACT) but its `tables`, `columns`, and `whereColumns` will still match
its sibling — i.e., it surfaces as STRUCTURAL. This matches common
intuition ("same query, just sorted differently").

## Known limitations

These are accepted trade-offs; we lean toward recall over precision.
False positives are cheap to dismiss; missing matches mean continued
duplication.

- **Subqueries.** A subquery in the `FROM` clause (e.g.
  `FROM (SELECT ...) sub`) is skipped — we walk past the parenthesized
  block without descending into it. Outer-level columns and tables
  outside the subquery are still captured.
- **CTEs (`WITH` clauses).** Not specially handled. Tables defined in a
  CTE will appear as `tables[]` entries alongside real tables.
- **Set operations (`UNION`, `INTERSECT`, `EXCEPT`).** We extract from
  the first SELECT only. The second arm of a `UNION` is missed.
- **Function-style joins / dialect-specific syntax.** `APPLY`,
  `LATERAL`, table-valued functions, etc. are not modeled. They may
  produce odd entries in `tables[]`.
- **Complex SELECT items.** `CASE WHEN ... THEN ... END AS x` collapses
  to whatever fragment the alias-stripper extracts; the result may be
  the literal `case`. This is best-effort.
- **Concatenated SQL strings.** `queryExecute("SELECT ... " & "FROM
  ...", ...)` is supported only for plain string-literal concatenation
  with `&`. Variable interpolation inside the string is preserved
  verbatim (and gets lower-priority normalization).
- **Dynamic SQL (`<cfif>` inside the query body).** The `rawSQL`
  preserves it; normalization treats it as text. Matches involving
  conditional SQL are flagged as approximate in diagnostics.
- **Identifier-equivalence under casing.** `User_ID` and `user_id` are
  treated as different identifiers by default, since database
  collations vary. Set `cfml-refactor.normalizeIdentifierCase` to
  `true` to fold them together.
- **Aliases in column extraction.** An alias of 4+ characters that does
  not start with a keyword may be incorrectly preserved as the column
  name. The alias-stripping heuristic is intentionally conservative.
- **Stored procedures (`<cfstoredproc>`).** Out of scope for Phase 5.
- **Cross-dialect edge cases.** SQL Server `[bracketed]` identifiers
  and MySQL backtick identifiers are stripped where recognized but not
  exhaustively. Mixed dialects in one workspace are not specifically
  supported.

If a match looks wrong, the normalized SQL is shown in the webview
panel side-by-side, so you can verify the comparison the tool used. If
you spot a normalization bug worth fixing, the relevant code is in
[src/index/normalize.ts](../src/index/normalize.ts).

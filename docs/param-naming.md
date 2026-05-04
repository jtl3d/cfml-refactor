# Parameter naming

When the Phase 2 transformer rewrites a `<cfquery>` into a `queryExecute()`
call, every `<cfqueryparam>` becomes a named entry in the second argument
(the params struct). Because tag-form `<cfqueryparam>` does not carry an
explicit script-level name, the transformer derives one. The rules below
are applied in order; the first one that produces a name wins.

## 1. Simple variable reference

If the param's `value` attribute is a single CFML interpolation that wraps
a plain identifier path, the param takes the name of the last segment.

| Source value          | Generated name |
|-----------------------|----------------|
| `value="#url.deptId#"`  | `deptId`     |
| `value="#form.userName#"` | `userName` |
| `value="#arguments.id#"` | `id`        |
| `value="#name#"`        | `name`       |

A simple variable reference must match `#identifier(.identifier)*#` end-to-
end with no other `#` characters. `value="user_#x#"` is not simple — it
falls through to rule 3.

## 2. Collision suffix

If two or more `<cfqueryparam>` entries in the same query would otherwise
produce the same name, the second and subsequent ones get a numeric suffix.

```
WHERE id = <cfqueryparam value="#a.id#" ...>
   OR id = <cfqueryparam value="#b.id#" ...>
   OR id = <cfqueryparam value="#c.id#" ...>
```

becomes

```
WHERE id = :id
   OR id = :id2
   OR id = :id3
```

The first occurrence keeps the bare name; only collisions are suffixed.
The counter is per-query, not per-file.

## 3. Column inferred from SQL

If the `value` is a literal (`value="#1#"`, `value="active"`, etc.), the
transformer scans the SQL text immediately preceding the `<cfqueryparam>`
tag for a comparison of the form `<column> <operator>` and uses the
column name. Supported operators: `=`, `<>`, `!=`, `<=`, `>=`, `<`, `>`,
`LIKE`, `IS`, `IS NOT`, `IN`. A qualified name like `t.column` reduces to
the last segment (`column`).

```
WHERE active = <cfqueryparam value="#1#" ...>
```

becomes

```
WHERE active = :active
```

with `active: { value: 1, ... }` in the params struct.

## 4. Fallback

If neither rule 1 nor rule 3 applies (for example, the comparison is too
complex or the param sits inside a function call or sub-select) the
transformer falls back to `param1`, `param2`, … and emits a
`// TODO: rename param "paramN"` comment immediately above the
`queryExecute(` call. The fallback counter coexists with the collision
counter; if `param1` is already taken, the next fallback is `param2`,
and so on.

## When the whole query is skipped

These rules only run for queries the transformer is willing to touch.
If a `<cfqueryparam>` `value` attribute contains a `(` (likely a function
call with possible side effects) the entire query is skipped and logged
to the output channel — no naming is attempted.

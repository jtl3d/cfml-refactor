# Configuration

## Datasource exclusion

If your application has a default datasource configured in Application.cfc
(e.g. `this.datasource = "myAppMain"`), you may not want to repeat the
datasource in every `queryExecute` call. Configure patterns matching your
default datasource(s) and they'll be omitted from the output:

```json
{
  "cfml-refactor.defaultDatasourcePatterns": [
    "#application.dsn#",
    "myAppMain",
    "myAppMain_RW"
  ]
}
```

Patterns match the literal source text of the `datasource` attribute. If
the attribute value matches any pattern, it's excluded from the output.

The resulting `queryExecute` call shape adapts to what's left:

| Datasource matched? | Has params? | Other options? | Output                              |
| ------------------- | ----------- | -------------- | ----------------------------------- |
| Yes                 | No          | No             | `queryExecute(sql)`                 |
| Yes                 | Yes         | No             | `queryExecute(sql, params)`         |
| Yes                 | Yes         | Yes            | `queryExecute(sql, params, opts)`   |
| Yes                 | No          | Yes            | `queryExecute(sql, {}, opts)`       |
| No                  | —           | —              | unchanged from Phase 2 default      |

Matching is **exact-string** against the literal attribute text — no glob
or regex patterns. To match both an interpolated and a literal form of the
same datasource, list both patterns.

## Conditional SQL conversion

`<cfquery>` bodies containing `<cfif>` / `<cfelseif>` / `<cfelse>` are
converted into one of two output styles. The choice is made automatically
per query.

### Style A — ternary

Used when every conditional branch contains text only (no
`<cfqueryparam>` and no other tags) AND the chain ends with `<cfelse>`.

```cfml
<cfquery name="getUsers" datasource="appdb">
    SELECT * FROM users
    WHERE active = 1
    <cfif sortDesc>
        ORDER BY name DESC
    <cfelse>
        ORDER BY name ASC
    </cfif>
</cfquery>
```

becomes:

```cfml
<cfscript>
    prc.getUsers = queryExecute(
        "SELECT * FROM users WHERE active = 1 "
        & (sortDesc ? "ORDER BY name DESC" : "ORDER BY name ASC"),
        {},
        { datasource: "appdb" }
    );
</cfscript>
```

### Style B — variable-based

Used whenever any branch contains a `<cfqueryparam>` (the common case) or
the conditional structure doesn't qualify for Style A.

```cfml
<cfquery name="getUsers" datasource="appdb">
    SELECT * FROM users WHERE active = 1
    <cfif structKeyExists(url, "deptId")>
        AND dept_id = <cfqueryparam value="#url.deptId#" cfsqltype="cf_sql_integer">
    </cfif>
</cfquery>
```

becomes:

```cfml
<cfscript>
    var sql = "SELECT * FROM users WHERE active = 1";
    var params = {};

    if (structKeyExists(url, "deptId")) {
        sql &= " AND dept_id = :deptId";
        params.deptId = { value: url.deptId, cfsqltype: "cf_sql_integer" };
    }

    prc.getUsers = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>
```

The chosen style and reason are written to the **CFML Refactor** output
channel after each conversion.

### What's still skipped

The following constructs inside a `<cfquery>` body are not converted and
are logged as skipped:

- Nested `<cfif>` inside `<cfif>` — combinatorial; convert manually.
- `<cfloop>` inside `<cfquery>` — usually building dynamic IN() lists;
  prefer `list="true"` on `<cfqueryparam>`.
- `<cfset>` inside `<cfquery>` — side effects mid-query; rare.

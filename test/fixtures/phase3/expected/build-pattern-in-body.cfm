<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    sql = "SELECT id, name FROM users";
    params = {};
    if (len(url.search ?: "")) {
        sql &= " WHERE name LIKE :term";
        params.term = { value: "%" & url.search & "%", cfsqltype: "cf_sql_varchar" };
    }
    prc.users = queryExecute(sql, params, {});
</cfscript>

<cfoutput>
    <h1>User Search</h1>

    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

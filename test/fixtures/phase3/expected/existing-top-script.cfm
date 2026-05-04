<cfscript>
    param name="url.deptId" default=0;

    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.users = queryExecute(
        "SELECT id, name FROM users WHERE dept_id = :id",
        { id: { value: url.deptId, cfsqltype: "cf_sql_integer" } },
        {}
    );
</cfscript>

<cfoutput>

    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

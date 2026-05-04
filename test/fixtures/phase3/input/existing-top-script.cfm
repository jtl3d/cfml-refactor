<cfscript>
    param name="url.deptId" default=0;
</cfscript>

<cfoutput>
    <cfscript>
        prc.users = queryExecute(
            "SELECT id, name FROM users WHERE dept_id = :id",
            { id: { value: url.deptId, cfsqltype: "cf_sql_integer" } },
            {}
        );
    </cfscript>

    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

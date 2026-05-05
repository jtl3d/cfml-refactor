<cfoutput>
    <cfloop query="prc.depts">
        <h2>#name#</h2>
        <cfscript>
            prc.users = queryExecute(
                "SELECT id, name FROM users WHERE dept_id = :id",
                { id: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
                {}
            );
        </cfscript>
        <cfif url.showProjects eq "true">
            <cfscript>
                prc.projects = queryExecute(
                    "SELECT id, name FROM projects WHERE dept_id = :id",
                    { id: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
                    {}
                );
            </cfscript>
        </cfif>
    </cfloop>
</cfoutput>

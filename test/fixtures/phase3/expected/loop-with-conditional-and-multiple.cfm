<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.viewModel = [];
    cfloop(query="prc.depts") {
        var vmRow = {};
        vmRow.users = queryExecute(
            "SELECT id, name FROM users WHERE dept_id = :id",
            { id: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
            {}
        );
        if (url.showProjects eq "true") {
            vmRow.projects = queryExecute(
                "SELECT id, name FROM projects WHERE dept_id = :id",
                { id: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
                {}
            );
        }
        arrayAppend(prc.viewModel, vmRow);
    }
</cfscript>

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

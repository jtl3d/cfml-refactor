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
        <cfset users = prc.viewModel[prc.depts.currentRow].users>
        <cfset projects = prc.viewModel[prc.depts.currentRow].projects>
        <h2>#name#</h2>
        <cfif url.showProjects eq "true">
        </cfif>
    </cfloop>
</cfoutput>

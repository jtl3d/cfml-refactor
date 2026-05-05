<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.depts = queryExecute("SELECT id, name FROM departments", {}, {});

    prc.viewModel = [];
    cfloop(query="prc.depts") {
        var vmRow = {};
        vmRow.deptUsers = queryExecute(
            "SELECT id, name FROM users WHERE dept_id = :deptId",
            { deptId: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
            {}
        );
        arrayAppend(prc.viewModel, vmRow);
    }
</cfscript>

<cfoutput>

    <cfloop query="prc.depts">
        <cfset deptUsers = prc.viewModel[prc.depts.currentRow].deptUsers>
        <h2>#name#</h2>
    </cfloop>
</cfoutput>

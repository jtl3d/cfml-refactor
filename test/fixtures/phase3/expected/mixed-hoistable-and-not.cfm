<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.depts = queryExecute("SELECT id, name FROM departments", {}, {});

    if (url.mode eq "admin") {
        prc.adminFlags = queryExecute(
            "SELECT id, flag FROM admin_flags",
            {},
            {}
        );
    }

    prc.viewModel = [];
    cfloop(query="prc.depts") {
        var vmRow = {};
        vmRow.userOrders = queryExecute(
            "SELECT id FROM orders WHERE dept_id = :id",
            { id: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
            {}
        );
        arrayAppend(prc.viewModel, vmRow);
    }

    // SKIPPED: prc.errorLog — inside <cftry>
</cfscript>

<cfoutput>
    <h1>Department Report</h1>

    <!--- Data fetched in hoisted block above --->
    <cfif url.mode eq "admin">
    </cfif>

    <cfloop query="prc.depts">
        <cfset userOrders = prc.viewModel[prc.depts.currentRow].userOrders>
        <h2>#name#</h2>
    </cfloop>

    <cftry>
        <cfscript>
            prc.errorLog = queryExecute("SELECT id FROM errors", {}, {});
        </cfscript>
        <cfcatch type="any">
            <p>err</p>
        </cfcatch>
    </cftry>
</cfoutput>

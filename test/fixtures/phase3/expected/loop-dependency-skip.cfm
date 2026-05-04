<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.depts = queryExecute("SELECT id, name FROM departments", {}, {});

    // SKIPPED: prc.deptUsers — inside <cfloop query="prc.depts">
</cfscript>

<cfoutput>

    <cfloop query="prc.depts">
        <h2>#name#</h2>
        <cfscript>
            prc.deptUsers = queryExecute(
                "SELECT id, name FROM users WHERE dept_id = :deptId",
                { deptId: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
                {}
            );
        </cfscript>
    </cfloop>
</cfoutput>

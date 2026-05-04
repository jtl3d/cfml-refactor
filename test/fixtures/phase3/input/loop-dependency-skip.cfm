<cfoutput>
    <cfscript>
        prc.depts = queryExecute("SELECT id, name FROM departments", {}, {});
    </cfscript>

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

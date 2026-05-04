<cfoutput>
    <h1>Department Report</h1>

    <cfscript>
        prc.depts = queryExecute("SELECT id, name FROM departments", {}, {});
    </cfscript>

    <cfif url.mode eq "admin">
        <cfscript>
            prc.adminFlags = queryExecute(
                "SELECT id, flag FROM admin_flags",
                {},
                {}
            );
        </cfscript>
    </cfif>

    <cfloop query="prc.depts">
        <h2>#name#</h2>
        <cfscript>
            prc.userOrders = queryExecute(
                "SELECT id FROM orders WHERE dept_id = :id",
                { id: { value: prc.depts.id, cfsqltype: "cf_sql_integer" } },
                {}
            );
        </cfscript>
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

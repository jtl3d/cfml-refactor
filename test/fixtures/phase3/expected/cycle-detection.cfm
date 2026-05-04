<cfoutput>
    <cfscript>
        prc.a = queryExecute(
            "SELECT 1 WHERE x = :x",
            { x: { value: prc.b.n, cfsqltype: "cf_sql_integer" } },
            {}
        );
    </cfscript>

    <cfscript>
        prc.b = queryExecute(
            "SELECT 1 WHERE y = :y",
            { y: { value: prc.a.n, cfsqltype: "cf_sql_integer" } },
            {}
        );
    </cfscript>
</cfoutput>

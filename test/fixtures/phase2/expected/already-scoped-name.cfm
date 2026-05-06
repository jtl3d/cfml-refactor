<cfscript>
    variables.getThing = queryExecute(
        "
            SELECT * FROM things WHERE id = :id
        ",
        {
            id: { value: url.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

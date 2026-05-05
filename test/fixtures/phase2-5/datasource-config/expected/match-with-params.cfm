<cfscript>
    prc.getX = queryExecute(
        "
            SELECT * FROM users WHERE id = :id
        ",
        {
            id: { value: url.id, cfsqltype: "cf_sql_integer" }
        }
    );
</cfscript>

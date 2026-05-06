<cfscript>
    getByName = queryExecute(
        "
            SELECT * FROM users WHERE name = ""literal"" AND id = :id
        ",
        {
            id: { value: url.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

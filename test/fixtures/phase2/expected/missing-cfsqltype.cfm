<cfscript>
    // TODO: cfsqltype missing for "id", defaulted to cf_sql_varchar
    getUsers = queryExecute(
        "
            SELECT * FROM users WHERE id = :id
        ",
        {
            id: { value: url.id, cfsqltype: "cf_sql_varchar" }
        },
        { datasource: "appdb" }
    );
</cfscript>

<cfscript>
    prc.getStuff = queryExecute(
        "
            SELECT id FROM widgets
            WHERE active = 1
              AND code = 'A1'
              AND ranking = 42
              AND owner_id = :userId
        ",
        {
            userId: { value: url.userId, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

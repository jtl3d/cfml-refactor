<cfscript>
    prc.getStuff = queryExecute(
        "
            SELECT * FROM stuff
            WHERE owner_id = :userId
               OR creator_id = :userId
               OR editor_id = :userId
        ",
        {
            userId: { value: url.userId, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

<cfscript>
    prc.getRow = queryExecute(
        "
            SELECT * FROM things
            WHERE owner_id = :userId
              AND name = :userName
        ",
        {
            userId: { value: arguments.userId, cfsqltype: "cf_sql_integer" },
            userName: { value: form.userName, cfsqltype: "cf_sql_varchar" }
        },
        { datasource: "appdb" }
    );
</cfscript>

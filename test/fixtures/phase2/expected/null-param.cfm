<cfscript>
    prc.upsertUser = queryExecute(
        "
            UPDATE users SET nickname = :nickname
            WHERE id = :id
        ",
        {
            nickname: { value: "", cfsqltype: "cf_sql_varchar", null: true },
            id: { value: url.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

<cfscript>
    prc.getActive = queryExecute(
        "
            SELECT id, name FROM users
            WHERE active = :active
              AND status = :status
        ",
        {
            active: { value: 1, cfsqltype: "cf_sql_bit" },
            status: { value: "approved", cfsqltype: "cf_sql_varchar" }
        },
        { datasource: "appdb" }
    );
</cfscript>

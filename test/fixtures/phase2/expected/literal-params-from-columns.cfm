<cfscript>
    prc.getActive = queryExecute(
        "
            SELECT id, name FROM users
            WHERE active = :active
              AND status = 'approved'
        ",
        {
            active: { value: 1, cfsqltype: "cf_sql_bit" }
        },
        { datasource: "appdb" }
    );
</cfscript>

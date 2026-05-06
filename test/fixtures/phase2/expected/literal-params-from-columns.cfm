<cfscript>
    getActive = queryExecute(
        "
            SELECT id, name FROM users
            WHERE active = 1
              AND status = 'approved'
        ",
        {},
        { datasource: "appdb" }
    );
</cfscript>

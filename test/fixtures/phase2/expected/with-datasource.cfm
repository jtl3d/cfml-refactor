<cfscript>
    prc.getCount = queryExecute(
        "
            SELECT COUNT(*) AS cnt FROM users
        ",
        {},
        { datasource: "appdb" }
    );
</cfscript>

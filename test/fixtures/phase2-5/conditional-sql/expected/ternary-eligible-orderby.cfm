<cfscript>
    prc.getUsers = queryExecute(
        "SELECT * FROM users WHERE active = 1 "
        & (sortDesc ? "ORDER BY name DESC" : "ORDER BY name ASC"),
        {},
        { datasource: "appdb" }
    );
</cfscript>

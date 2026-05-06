<cfscript>
    prc.getUsers = queryExecute(
        "
            SELECT id, name FROM users
        ",
        {},
        { datasource: "appdb" }
    );
</cfscript>

<cfscript>
    prc.getOrders = queryExecute(
        "
            SELECT id, total FROM orders WHERE user_id = :id
        ",
        {
            id: { value: prc.getUsers.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

<cfif prc.getUsers.recordCount GT 0>
    <p>have users</p>
</cfif>

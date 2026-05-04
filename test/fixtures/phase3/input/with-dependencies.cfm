<cfoutput>
    <h1>Account Detail</h1>

    <cfscript>
        prc.account = queryExecute(
            "SELECT id, name, owner_id FROM accounts WHERE id = :id",
            { id: { value: url.accountId, cfsqltype: "cf_sql_integer" } },
            {}
        );
    </cfscript>

    <h2>#prc.account.name#</h2>

    <cfscript>
        prc.owner = queryExecute(
            "SELECT id, name FROM users WHERE id = :id",
            { id: { value: prc.account.owner_id, cfsqltype: "cf_sql_integer" } },
            {}
        );
    </cfscript>

    <p>Owner: #prc.owner.name#</p>
</cfoutput>

<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.account = queryExecute(
        "SELECT id, name, owner_id FROM accounts WHERE id = :id",
        { id: { value: url.accountId, cfsqltype: "cf_sql_integer" } },
        {}
    );
    prc.owner = queryExecute(
        "SELECT id, name FROM users WHERE id = :id",
        { id: { value: prc.account.owner_id, cfsqltype: "cf_sql_integer" } },
        {}
    );
</cfscript>

<cfoutput>
    <h1>Account Detail</h1>

    <h2>#prc.account.name#</h2>

    <p>Owner: #prc.owner.name#</p>
</cfoutput>

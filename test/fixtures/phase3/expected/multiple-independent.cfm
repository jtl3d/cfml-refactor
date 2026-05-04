<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.userCount = queryExecute("SELECT COUNT(*) AS n FROM users", {}, {});
    prc.deptCount = queryExecute("SELECT COUNT(*) AS n FROM departments", {}, {});
    prc.orderCount = queryExecute("SELECT COUNT(*) AS n FROM orders", {}, {});
</cfscript>

<cfoutput>
    <h1>Stats</h1>

    <p>Users: #prc.userCount.n#</p>
    <p>Depts: #prc.deptCount.n#</p>

    <p>Orders: #prc.orderCount.n#</p>
</cfoutput>

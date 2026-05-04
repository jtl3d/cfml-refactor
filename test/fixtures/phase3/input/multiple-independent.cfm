<cfoutput>
    <h1>Stats</h1>

    <cfscript>
        prc.userCount = queryExecute("SELECT COUNT(*) AS n FROM users", {}, {});
    </cfscript>

    <cfscript>
        prc.deptCount = queryExecute("SELECT COUNT(*) AS n FROM departments", {}, {});
    </cfscript>

    <p>Users: #prc.userCount.n#</p>
    <p>Depts: #prc.deptCount.n#</p>

    <cfscript>
        prc.orderCount = queryExecute("SELECT COUNT(*) AS n FROM orders", {}, {});
    </cfscript>

    <p>Orders: #prc.orderCount.n#</p>
</cfoutput>

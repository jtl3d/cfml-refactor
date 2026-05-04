<cfoutput>
    <h1>Users</h1>

    <cfscript>
        prc.users = queryExecute("SELECT * FROM users", {}, {});
    </cfscript>

    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

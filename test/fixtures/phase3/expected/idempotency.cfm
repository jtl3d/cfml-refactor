<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.users = queryExecute("SELECT * FROM users", {}, {});
</cfscript>

<cfoutput>
    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

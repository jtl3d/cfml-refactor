<cfoutput>
    <h1>Dashboard</h1>

    <cfif url.showStats eq "true">
        <cfscript>
            prc.stats = queryExecute(
                "SELECT COUNT(*) AS total FROM events",
                {},
                {}
            );
        </cfscript>

        <p>Total: #prc.stats.total#</p>
    </cfif>
</cfoutput>

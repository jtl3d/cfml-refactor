<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    if (url.showStats eq "true") {
        prc.stats = queryExecute(
            "SELECT COUNT(*) AS total FROM events",
            {},
            {}
        );
    }
</cfscript>

<cfoutput>
    <h1>Dashboard</h1>

    <!--- Data fetched in hoisted block above --->
    <cfif url.showStats eq "true">

        <p>Total: #prc.stats.total#</p>
    </cfif>
</cfoutput>

<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    if (url.mode eq "admin") {
        prc.adminData = queryExecute(
            "SELECT id, label FROM admin_panel WHERE active = 1",
            {},
            {}
        );
    }
</cfscript>

<cfoutput>
    <!--- Data fetched in hoisted block above --->
    <cfif url.mode eq "admin">
        <h2>Admin View</h2>
        <p>#prc.adminData.label#</p>
    </cfif>
</cfoutput>

<cfoutput>
    <cfif url.mode eq "admin">
        <cfscript>
            prc.adminData = queryExecute(
                "SELECT id, label FROM admin_panel WHERE active = 1",
                {},
                {}
            );
        </cfscript>
        <h2>Admin View</h2>
        <p>#prc.adminData.label#</p>
    </cfif>
</cfoutput>

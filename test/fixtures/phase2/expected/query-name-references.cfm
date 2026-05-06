<cfscript>
    prc.getUsers = queryExecute(
        "
            SELECT id, name FROM users WHERE id = :id
        ",
        {
            id: { value: url.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

<cfif prc.getUsers.recordCount GT 0>
    <cfoutput query="prc.getUsers">
        <p>#prc.getUsers.name# (#prc.getUsers.id#)</p>
    </cfoutput>
</cfif>

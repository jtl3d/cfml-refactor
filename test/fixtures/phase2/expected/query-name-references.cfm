<cfscript>
    getUsers = queryExecute(
        "
            SELECT id, name FROM users WHERE id = :id
        ",
        {
            id: { value: url.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

<cfif variables.getUsers.recordCount GT 0>
    <cfoutput query="getUsers">
        <p>#getUsers.name# (#variables.getUsers.id#)</p>
    </cfoutput>
</cfif>

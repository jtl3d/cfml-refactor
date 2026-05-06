<cfquery name="getUsers" datasource="appdb">
    SELECT id, name FROM users WHERE id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfif variables.getUsers.recordCount GT 0>
    <cfoutput query="getUsers">
        <p>#getUsers.name# (#variables.getUsers.id#)</p>
    </cfoutput>
</cfif>

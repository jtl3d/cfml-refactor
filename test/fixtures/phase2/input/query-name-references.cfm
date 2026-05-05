<cfquery name="getUsers" datasource="appdb">
    SELECT id, name FROM users WHERE id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfif getUsers.recordCount GT 0>
    <cfoutput query="getUsers">
        <p>#getUsers.name#</p>
    </cfoutput>
</cfif>

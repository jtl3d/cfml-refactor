<cfquery name="getUsers" datasource="appdb">
    SELECT * FROM users WHERE id = <cfqueryparam value="#url.id#">
</cfquery>

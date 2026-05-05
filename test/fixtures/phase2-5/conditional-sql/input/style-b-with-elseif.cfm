<cfquery name="getUsers" datasource="appdb">
    SELECT * FROM users
    WHERE 1 = 1
    <cfif sortBy EQ "name">
        ORDER BY name
    <cfelseif sortBy EQ "created">
        ORDER BY created_at
        AND created_by = <cfqueryparam value="#arguments.createdBy#" cfsqltype="cf_sql_integer">
    <cfelse>
        ORDER BY id
    </cfif>
</cfquery>

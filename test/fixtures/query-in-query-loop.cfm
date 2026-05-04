<cfquery name="getUsers" datasource="appdb">
    SELECT id FROM users
</cfquery>

<cfloop query="getUsers">
    <cfquery name="getOrders" datasource="appdb">
        SELECT * FROM orders WHERE user_id = <cfqueryparam value="#getUsers.id#" cfsqltype="cf_sql_integer">
        <cfif url.recent EQ 1>
            AND created_at > DATEADD(day, -7, GETDATE())
        </cfif>
    </cfquery>
</cfloop>

<cfquery name="getUsers" datasource="appdb">
    SELECT id, name FROM users
</cfquery>

<cfquery name="getOrders" datasource="appdb">
    SELECT id, total FROM orders WHERE user_id = <cfqueryparam value="#getUsers.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfif getUsers.recordCount GT 0>
    <p>have users</p>
</cfif>

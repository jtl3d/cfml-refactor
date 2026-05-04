<cfquery name="getByName" datasource="appdb">
    SELECT * FROM users WHERE name = "literal" AND id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
</cfquery>

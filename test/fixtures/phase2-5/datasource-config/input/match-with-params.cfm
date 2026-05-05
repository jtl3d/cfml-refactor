<cfquery name="getX" datasource="#application.dsn#">
    SELECT * FROM users WHERE id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfquery name="getThings" datasource="appdb">
    <cfset local.x = 1>
    SELECT * FROM things WHERE id = <cfqueryparam value="#local.x#" cfsqltype="cf_sql_integer">
</cfquery>

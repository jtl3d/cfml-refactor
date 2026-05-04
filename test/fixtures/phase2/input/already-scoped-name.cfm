<cfquery name="variables.getThing" datasource="appdb">
    SELECT * FROM things WHERE id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfquery name="getRows" datasource="appdb">
    SELECT id FROM things WHERE 1 = 1
    <cfif structKeyExists(arguments, "id")>
        AND id = <cfqueryparam value="#arguments.id#" cfsqltype="cf_sql_integer">
    </cfif>
</cfquery>

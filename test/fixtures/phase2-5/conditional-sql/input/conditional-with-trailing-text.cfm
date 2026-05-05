<cfquery name="getRows" datasource="appdb">
    <cfif structKeyExists(arguments, "filter")>
        SELECT id FROM filtered_things
        WHERE filter = <cfqueryparam value="#arguments.filter#" cfsqltype="cf_sql_varchar">
    </cfif>
    ORDER BY id DESC
</cfquery>

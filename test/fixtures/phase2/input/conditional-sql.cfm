<cfquery name="getMaybe" datasource="appdb">
    SELECT * FROM things
    WHERE 1 = 1
    <cfif structKeyExists(url, "name")>
        AND name = <cfqueryparam value="#url.name#" cfsqltype="cf_sql_varchar">
    </cfif>
</cfquery>

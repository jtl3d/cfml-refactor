<cfquery name="foo" datasource="appdb">
    SELECT id, name
    FROM users
    WHERE 1=1
    <cfif structKeyExists(url, "x")>
        AND x = <cfqueryparam value="#url.x#" cfsqltype="cf_sql_integer">
    </cfif>
    ORDER BY name
</cfquery>

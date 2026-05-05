<cfquery name="getMatches" datasource="appdb">
    SELECT * FROM matches
    WHERE 1=1
    <cfif structKeyExists(url, "userId")>
        AND user_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
    </cfif>
    <cfif structKeyExists(url, "minScore")>
        AND score >= <cfqueryparam value="#url.minScore#" cfsqltype="cf_sql_integer">
    </cfif>
</cfquery>

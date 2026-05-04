<cfquery name="upsertUser" datasource="appdb">
    UPDATE users SET nickname = <cfqueryparam value="" null="true" cfsqltype="cf_sql_varchar">
    WHERE id = <cfqueryparam value="#url.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfquery name="getStuff" datasource="appdb">
    SELECT id FROM widgets
    WHERE active = <cfqueryparam value="#1#" cfsqltype="cf_sql_bit">
      AND code = <cfqueryparam value="#'A1'#" cfsqltype="cf_sql_varchar">
      AND ranking = <cfqueryparam value="42" cfsqltype="cf_sql_integer">
      AND owner_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
</cfquery>

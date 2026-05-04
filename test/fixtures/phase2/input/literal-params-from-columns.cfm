<cfquery name="getActive" datasource="appdb">
    SELECT id, name FROM users
    WHERE active = <cfqueryparam value="#1#" cfsqltype="cf_sql_bit">
      AND status = <cfqueryparam value="approved" cfsqltype="cf_sql_varchar">
</cfquery>

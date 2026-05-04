<cfquery name="getRow" datasource="appdb">
    SELECT * FROM things
    WHERE owner_id = <cfqueryparam value="#arguments.userId#" cfsqltype="cf_sql_integer">
      AND name = <cfqueryparam value="#form.userName#" cfsqltype="cf_sql_varchar">
</cfquery>

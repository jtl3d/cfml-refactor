<cfquery name="getStuff" datasource="appdb">
    SELECT * FROM stuff
    WHERE owner_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
       OR creator_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
       OR editor_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
</cfquery>

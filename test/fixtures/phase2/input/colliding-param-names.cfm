<cfquery name="getStuff" datasource="appdb">
    SELECT * FROM stuff
    WHERE id = <cfqueryparam value="#a.id#" cfsqltype="cf_sql_integer">
       OR id = <cfqueryparam value="#b.id#" cfsqltype="cf_sql_integer">
       OR id = <cfqueryparam value="#c.id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfloop from="1" to="10" index="i">
    <cfquery name="getRow" datasource="appdb">
        SELECT * FROM nums WHERE n = <cfqueryparam value="#i#" cfsqltype="cf_sql_integer">
    </cfquery>
</cfloop>

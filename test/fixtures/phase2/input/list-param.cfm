<cfquery name="getByIds" datasource="appdb">
    SELECT * FROM widgets
    WHERE id IN (<cfqueryparam value="#url.ids#" list="true" cfsqltype="cf_sql_integer">)
</cfquery>

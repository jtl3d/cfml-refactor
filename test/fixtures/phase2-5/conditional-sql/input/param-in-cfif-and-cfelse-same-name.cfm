<cfquery name="getRows" datasource="appdb">
    SELECT * FROM things WHERE 1 = 1
    <cfif useUrl>
        AND dept_id = <cfqueryparam value="#url.deptId#" cfsqltype="cf_sql_integer">
    <cfelse>
        AND dept_id = <cfqueryparam value="#form.deptId#" cfsqltype="cf_sql_integer">
    </cfif>
</cfquery>

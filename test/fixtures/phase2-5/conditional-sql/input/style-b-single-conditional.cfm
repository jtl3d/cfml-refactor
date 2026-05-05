<cfquery name="getUsers" datasource="appdb">
    SELECT * FROM users
    WHERE active = 1
    <cfif structKeyExists(url, "deptId")>
        AND dept_id = <cfqueryparam value="#url.deptId#" cfsqltype="cf_sql_integer">
    </cfif>
</cfquery>

<cfquery name="getUsers" datasource="myDsn">
    SELECT id, name, email
    FROM users
    WHERE active = <cfqueryparam value="#1#" cfsqltype="cf_sql_bit">
      AND dept_id = <cfqueryparam value="#url.deptId#" cfsqltype="cf_sql_integer">
</cfquery>

<cfquery name="getUsers" datasource="appdb">
    SELECT id, name
    FROM users
    WHERE dept_id = <cfqueryparam name="deptId" value="#url.dept#" cfsqltype="cf_sql_integer">
      AND status = <cfqueryparam name="status" value="active" cfsqltype="cf_sql_varchar">
</cfquery>

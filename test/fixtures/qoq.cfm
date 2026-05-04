<cfquery name="getUsers" datasource="appdb">
    SELECT id, name, dept_id FROM users
</cfquery>

<cfquery name="getActive" dbtype="query">
    SELECT id, name FROM getUsers WHERE dept_id = 5
</cfquery>

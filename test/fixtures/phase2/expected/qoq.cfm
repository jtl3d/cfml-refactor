<cfquery name="getActive" dbtype="query">
    SELECT id, name FROM getUsers WHERE dept_id = 5
</cfquery>

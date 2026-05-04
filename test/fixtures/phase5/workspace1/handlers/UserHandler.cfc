<cfcomponent>
    <cffunction name="getUsers" access="public">
        <cfargument name="deptId" type="numeric" required="true">
        <cfscript>
            prc.users = queryExecute(
                "SELECT id, name FROM users WHERE dept_id = :deptId",
                { deptId: { value: arguments.deptId, cfsqltype: "cf_sql_integer" } }
            );
            return prc.users;
        </cfscript>
    </cffunction>
</cfcomponent>

<cfcomponent>
    <cffunction name="loadPermissions" access="public">
        <cfargument name="uid" type="numeric" required="true">
        <cfscript>
            local.perms = queryExecute(
                "SELECT permission_id, name FROM permissions WHERE user_id = :uid ORDER BY name",
                { uid: { value: arguments.uid, cfsqltype: "cf_sql_integer" } }
            );
            return local.perms;
        </cfscript>
    </cffunction>
</cfcomponent>

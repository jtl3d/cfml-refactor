<cfscript>
    sql = "SELECT id, name FROM users WHERE 1=1";
    params = {};
    if (url.filterActive eq "true") {
        sql &= " AND active = :active";
        params.active = { value: 1, cfsqltype: "cf_sql_bit" };
    }
    if (structKeyExists(url, "deptId")) {
        sql &= " AND dept_id = :deptId";
        params.deptId = { value: url.deptId, cfsqltype: "cf_sql_integer" };
    }
    prc.users = queryExecute(sql, params, {});
</cfscript>

<cfoutput>
    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

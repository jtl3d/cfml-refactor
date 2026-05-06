<cfscript>
    var sql = "
        SELECT * FROM users
        WHERE active = 1
    ";
    var params = {};

    if (structKeyExists(url, "deptId")) {
        sql &= " AND dept_id = :deptId";
        params.deptId = { value: url.deptId, cfsqltype: "cf_sql_integer" };
    }

    getUsers = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

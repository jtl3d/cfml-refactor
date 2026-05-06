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

    if (structKeyExists(url, "status")) {
        sql &= " AND status = :status";
        params.status = { value: url.status, cfsqltype: "cf_sql_varchar" };
    }

    prc.getUsers = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

<cfscript>
    var sql = "SELECT * FROM things WHERE 1 = 1";
    var params = {};

    if (useUrl) {
        sql &= " AND dept_id = :deptId";
        params.deptId = { value: url.deptId, cfsqltype: "cf_sql_integer" };
    } else {
        sql &= " AND dept_id = :deptId";
        params.deptId = { value: form.deptId, cfsqltype: "cf_sql_integer" };
    }

    getRows = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

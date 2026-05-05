<cfscript>
    var sql = "SELECT * FROM users WHERE 1 = 1";
    var params = {};

    if (sortBy EQ "name") {
        sql &= " ORDER BY name";
    } else if (sortBy EQ "created") {
        sql &= " ORDER BY created_at AND created_by = :createdBy";
        params.createdBy = { value: arguments.createdBy, cfsqltype: "cf_sql_integer" };
    } else {
        sql &= " ORDER BY id";
    }

    prc.getUsers = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

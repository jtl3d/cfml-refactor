<cfscript>
    var sql = "
        SELECT id, name
        FROM users
        WHERE 1=1
    ";
    var params = {};

    if (structKeyExists(url, "x")) {
        sql &= " AND x = :x";
        params.x = { value: url.x, cfsqltype: "cf_sql_integer" };
    }

    sql &= " ORDER BY name";

    prc.foo = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

<cfscript>
    var sql = "
        SELECT * FROM things
        WHERE 1 = 1
    ";
    var params = {};

    if (structKeyExists(url, "name")) {
        sql &= " AND name = :name";
        params.name = { value: url.name, cfsqltype: "cf_sql_varchar" };
    }

    prc.getMaybe = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

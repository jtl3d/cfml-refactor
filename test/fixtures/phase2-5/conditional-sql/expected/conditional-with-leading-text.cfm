<cfscript>
    var sql = "SELECT id FROM things WHERE 1 = 1";
    var params = {};

    if (structKeyExists(arguments, "id")) {
        sql &= " AND id = :id";
        params.id = { value: arguments.id, cfsqltype: "cf_sql_integer" };
    }

    prc.getRows = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

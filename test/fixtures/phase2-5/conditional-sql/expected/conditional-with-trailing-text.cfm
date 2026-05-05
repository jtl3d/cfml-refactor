<cfscript>
    var sql = "";
    var params = {};

    if (structKeyExists(arguments, "filter")) {
        sql &= " SELECT id FROM filtered_things WHERE filter = :filter";
        params.filter = { value: arguments.filter, cfsqltype: "cf_sql_varchar" };
    }

    sql &= " ORDER BY id DESC";

    prc.getRows = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

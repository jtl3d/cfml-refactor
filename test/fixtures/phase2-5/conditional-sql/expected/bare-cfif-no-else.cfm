<cfscript>
    var sql = "SELECT * FROM things WHERE 1 = 1";
    var params = {};

    if (showAll) {
        sql &= " AND visible = 1";
    }

    prc.getThings = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

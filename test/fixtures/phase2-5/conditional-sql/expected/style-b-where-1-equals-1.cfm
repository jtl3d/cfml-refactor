<cfscript>
    var sql = "SELECT * FROM matches WHERE 1=1";
    var params = {};

    if (structKeyExists(url, "userId")) {
        sql &= " AND user_id = :userId";
        params.userId = { value: url.userId, cfsqltype: "cf_sql_integer" };
    }

    if (structKeyExists(url, "minScore")) {
        sql &= " AND score >= :minScore";
        params.minScore = { value: url.minScore, cfsqltype: "cf_sql_integer" };
    }

    prc.getMatches = queryExecute(sql, params, { datasource: "appdb" });
</cfscript>

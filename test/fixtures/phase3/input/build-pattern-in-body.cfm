<cfoutput>
    <h1>User Search</h1>

    <cfscript>
        sql = "SELECT id, name FROM users";
        params = {};
        if (len(url.search ?: "")) {
            sql &= " WHERE name LIKE :term";
            params.term = { value: "%" & url.search & "%", cfsqltype: "cf_sql_varchar" };
        }
        prc.users = queryExecute(sql, params, {});
    </cfscript>

    <cfloop query="prc.users">
        <li>#name#</li>
    </cfloop>
</cfoutput>

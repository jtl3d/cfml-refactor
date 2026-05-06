<cfscript>
    prc.getUsers = queryExecute(
        "
            SELECT id, name, email
            FROM users
            WHERE active = 1
              AND dept_id = :deptId
        ",
        {
            deptId: { value: url.deptId, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "myDsn" }
    );
</cfscript>

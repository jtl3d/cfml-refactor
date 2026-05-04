<cfscript>
    prc.getUsers = queryExecute(
        "
            SELECT id, name, email
            FROM users
            WHERE active = :active
              AND dept_id = :deptId
        ",
        {
            active: { value: 1, cfsqltype: "cf_sql_bit" },
            deptId: { value: url.deptId, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "myDsn" }
    );
</cfscript>

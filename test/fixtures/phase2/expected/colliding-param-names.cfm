<cfscript>
    prc.getStuff = queryExecute(
        "
            SELECT * FROM stuff
            WHERE id = :id
               OR id = :id2
               OR id = :id3
        ",
        {
            id: { value: a.id, cfsqltype: "cf_sql_integer" },
            id2: { value: b.id, cfsqltype: "cf_sql_integer" },
            id3: { value: c.id, cfsqltype: "cf_sql_integer" }
        },
        { datasource: "appdb" }
    );
</cfscript>

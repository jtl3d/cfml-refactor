<cfscript>
    prc.getByIds = queryExecute(
        "
            SELECT * FROM widgets
            WHERE id IN (:ids)
        ",
        {
            ids: { value: url.ids, cfsqltype: "cf_sql_integer", list: true }
        },
        { datasource: "appdb" }
    );
</cfscript>

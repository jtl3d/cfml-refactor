<cfscript>
    prc.getThings = queryExecute(
        "SELECT id, name FROM things WHERE category = 'a' "
        & (includeArchived ? "AND archived = 1" : "AND archived = 0"),
        {},
        { datasource: "appdb" }
    );
</cfscript>

<cfscript>
    getX = queryExecute(
        "
            SELECT 1
        ",
        {},
        { datasource: "reporting" }
    );
</cfscript>

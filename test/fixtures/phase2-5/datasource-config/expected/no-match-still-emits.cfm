<cfscript>
    prc.getX = queryExecute(
        "
            SELECT 1
        ",
        {},
        { datasource: "reporting" }
    );
</cfscript>

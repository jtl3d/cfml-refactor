<cfscript>
    getActive = queryExecute(
        "
            SELECT id, name FROM getUsers WHERE dept_id = 5
        ",
        {},
        { dbtype: "query" }
    );
</cfscript>

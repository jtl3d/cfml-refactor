<cfscript>
    prc.getX = queryExecute(
        "
            SELECT 1
        ",
        {},
        { cachedwithin: 60 }
    );
</cfscript>

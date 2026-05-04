<cfoutput>
    <h1>Test</h1>

    <!--- @cfml-refactor:no-hoist --->
    <cfscript>
        prc.special = queryExecute("SELECT 1 AS n", {}, {});
    </cfscript>

    <p>#prc.special.n#</p>
</cfoutput>

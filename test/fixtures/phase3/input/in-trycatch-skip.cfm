<cfoutput>
    <cftry>
        <cfscript>
            prc.maybe = queryExecute("SELECT 1 AS n", {}, {});
        </cfscript>

        <cfcatch type="any">
            <p>Failed: #cfcatch.message#</p>
        </cfcatch>
    </cftry>
</cfoutput>

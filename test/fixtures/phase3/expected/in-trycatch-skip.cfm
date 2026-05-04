<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    // SKIPPED: prc.maybe — inside <cftry>
</cfscript>

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

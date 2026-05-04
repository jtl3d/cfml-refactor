<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    // SKIPPED: prc.both — nested inside more than one <cfif>
</cfscript>

<cfoutput>
    <cfif url.outer eq "true">
        <cfif url.inner eq "true">
            <cfscript>
                prc.both = queryExecute("SELECT 1 AS n", {}, {});
            </cfscript>
            <p>#prc.both.n#</p>
        </cfif>
    </cfif>
</cfoutput>

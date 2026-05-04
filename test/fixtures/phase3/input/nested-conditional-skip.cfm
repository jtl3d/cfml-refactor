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

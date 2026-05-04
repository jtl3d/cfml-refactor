<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    // SKIPPED: prc.pageData — inside <cfloop>
</cfscript>

<cfoutput>
    <cfloop from="1" to="10" index="i">
        <h2>Page #i#</h2>
        <cfscript>
            prc.pageData = queryExecute(
                "SELECT id, title FROM pages WHERE page_num = :n",
                { n: { value: i, cfsqltype: "cf_sql_integer" } },
                {}
            );
        </cfscript>
        <p>#prc.pageData.title#</p>
    </cfloop>
</cfoutput>

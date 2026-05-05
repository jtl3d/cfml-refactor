<cfscript>
    // ===== View model =====
    // Hoisted by cfml-refactor on 2026-05-04
    // TODO: Move these to the handler

    prc.viewModel = [];
    cfloop(from="1", to="10", index="i") {
        var vmRow = {};
        vmRow.pageData = queryExecute(
            "SELECT id, title FROM pages WHERE page_num = :n",
            { n: { value: i, cfsqltype: "cf_sql_integer" } },
            {}
        );
        arrayAppend(prc.viewModel, vmRow);
    }
</cfscript>

<cfoutput>
    <cfloop from="1" to="10" index="i">
        <cfset pageData = prc.viewModel[i].pageData>
        <h2>Page #i#</h2>
        <p>#pageData.title#</p>
    </cfloop>
</cfoutput>

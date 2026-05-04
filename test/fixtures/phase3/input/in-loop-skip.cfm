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
